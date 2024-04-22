import "https://deno.land/x/dotenv@v3.2.2/load.ts";
import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";

const kv = await Deno.openKv();

const HS_SECRET = Deno.env.get("HS_SECRET") || "";
const HS_APP_ID = Deno.env.get("HS_APP_ID") || "";
const HS_APP_SECRET = Deno.env.get("HS_APP_SECRET") || "";

const HS_AUTH_ENDPOINT = "https://api.helpscout.net/v2/oauth2/token";
const HS_CONVERSATION_ENDPOINT = "https://api.helpscout.net/v2/conversations/";
const HS_DASHBOARD_ENDPOINT = "https://secure.helpscout.net/conversation/";

const COMMANDS = {
  REOPEN: "REOPEN",
};

interface Task {
  reopenDate: number;
}

function isDate(dateString: string) {
  return !isNaN(new Date(dateString).getDate());
}

const calculateSignature = (secret: string, body: string) =>
  hmac("sha1", secret, body, "utf8", "base64");

const getAccessToken = async (appID: string, appSecret: string) => {
  try {
    const res = await fetch(HS_AUTH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&client_id=${appID}&client_secret=${appSecret}`,
    });
    const { access_token } = await res.json();
    return access_token;
  } catch (err) {
    throw new Error(err);
  }
};

const reopenConversation = async (
  conversationApi: string,
  accessToken: string
) => {
  try {
    await fetch(conversationApi, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "replace",
        path: "/status",
        value: "active",
      }),
    });
  } catch (err) {
    throw new Error(err);
  }
};

// Request handler
const handler = async (req: Request): Promise<Response> => {
  const { headers, method, url } = req;
  const hsSignature = headers.get("X-HelpScout-Signature");

  const { pathname } = new URL(url);
  const deleteEndpointRegex = /^\/api\/delete\/\d+$/gi;

  // Delete task handler
  if (deleteEndpointRegex.test(pathname) && method === "DELETE") {
    const taskId = parseInt(pathname.split("/").pop() ?? "");
    const task = await kv.get(["tasks", taskId]);
    console.log("Deleting task: ", task);
    await kv.delete(["tasks", taskId]);
    return new Response(null, {
      status: 200,
    });
  }

  if (method === "HEAD") {
    return new Response(null, {
      status: 200,
    });
  }

  // Task view
  if (method === "GET") {
    let tasks = [];
    for await (const task of kv.list<Task>({ prefix: ["tasks"] })) {
      tasks.push(task);
    }

    // Sort tasks
    tasks.sort((a, b) => a.value.reopenDate - b.value.reopenDate);

    tasks = tasks.map((task) => {
      const reopenDate = new Date(task.value.reopenDate).toDateString();
      const conversationLink = `<a href="${HS_DASHBOARD_ENDPOINT}${
        task.key[1] as string
      }">${task.key[1] as string}</a>`;
      return `<tr>
          <td>${conversationLink}</td>
          <td>${reopenDate}</td>
        </tr>`;
    });

    const html = `
    <style>
      table {
        border-collapse: collapse;
        width: 100%;
        color: #333333;
        font-family: Arial, sans-serif;
        font-size: 12px;
        text-align: left;
        overflow: hidden;
        box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
        margin: auto;
        margin-bottom: 50px;
      }
      table th {
        background-color: #333333;
        color: #ffffff;
        font-weight: bold;
        padding: 10px;
        text-transform: uppercase;
        letter-spacing: 1px;
        border-top: 1px solid #fff;
        border-bottom: 1px solid #cccccc;
      }
      table tr:nth-child(even) td {
        background-color: #f2f2f2;
      }
      table tr:hover td {
        background-color: #ffedcc;
      }
      table thead th:nth-of-type(1) {
        width: 20%;
        max-width: 200px;
      }
      table td {
        background-color: #ffffff;
        padding: 10px;
        border-bottom: 1px solid #cccccc;
        font-weight: bold;
      }
    </style>
    <div style="font-family: sans-serif">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Reopen date</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.join("\n")}
        </tbody>
      </table>
    </div>
    `;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
      },
    });
  }

  // Verifying request method
  if (method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "POST",
      },
    });
  }

  let rawPayload;

  try {
    rawPayload = await req.text();
  } catch (err) {
    console.error("Can't parse response body", err.message);
    return new Response(null, {
      status: 400,
    });
  }

  if (!hsSignature) {
    console.log("Signature missing");
    return new Response("Sgnature missing", {
      status: 200,
    });
  }

  // Verifying webhook signature
  if (hsSignature != calculateSignature(HS_SECRET, rawPayload)) {
    return new Response("Invalid signature", {
      status: 400,
    });
  }

  // Get webhook payload (Conversation object)
  const payload = JSON.parse(rawPayload);
  const { id, preview, status } = payload;

  const isCommand = preview[0] === "#";
  if (isCommand) {
    const command = preview.slice(1).split("@")[0];
    console.log("Command received: ", command);
    if (command === COMMANDS.REOPEN) {
      const reopenDate = preview.slice(1).split("@")[1];
      console.log("Reopen date: ", reopenDate);
      if (isDate(reopenDate)) {
        await kv.set(["tasks", id], {
          reopenDate: new Date(reopenDate).getTime(),
        });
        console.log("OK", id, preview, status);
      }
    }
  }

  return new Response(null, {
    status: 200,
  });
};

// Reopen conversation recurring job
Deno.cron("Reopen conversations", "0 */3 * * *", async () => {
  const currentDate = Date.now();
  const tasks = [];
  for await (const task of kv.list<Task>({ prefix: ["tasks"] })) {
    console.log(task.value.reopenDate, currentDate);
    if (task.value.reopenDate <= currentDate) {
      tasks.push(task.key[1] as string);
    }
  }
  if (tasks.length) {
    const token = await getAccessToken(HS_APP_ID, HS_APP_SECRET);
    tasks.forEach(async (task) => {
      await reopenConversation(`${HS_CONVERSATION_ENDPOINT}${task}`, token);
      await kv.delete(["tasks", task]);
    });
  }
});

// Start server
Deno.serve(handler);
