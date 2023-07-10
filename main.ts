import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  crypto,
  toHashString,
} from "https://deno.land/std@0.189.0/crypto/mod.ts";
import "https://deno.land/x/dotenv@v3.2.2/load.ts";

const PORT = Number(Deno.env.get("port")) || 3000;
const HS_SECRET = Deno.env.get("HS_SECRET") || "";

const calculateSignature = async (secret: string, body: string) => {
  const encoder = new TextEncoder();
  const algorithm = {
    name: "HMAC",
    hash: "SHA-1",
  };

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    algorithm,
    false,
    ["sign", "verify"]
  );
  const signature = await crypto.subtle.sign(
    algorithm.name,
    key,
    encoder.encode(body)
  );
  return toHashString(signature);
};

// Request handler
const handler = async (req: Request): Promise<Response> => {
  const { body, headers, method } = req;

  // Verifying request method
  if (method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "POST",
      },
    });
  }

  // Verifying request body
  if (!body) {
    return new Response(null, {
      status: 400,
    });
  }

  let payload;

  try {
    payload = await req.json();
  } catch (err) {
    console.error("Can't parse response body", err.message);
    return new Response(null, {
      status: 400,
    });
  }

  const hsSignature = headers.get("X-HelpScout-Signature");

  if (!hsSignature) {
    console.log("Signature missing");
    return new Response("Sgnature missing", {
      status: 200,
    });
  }

  const calculatedSignature = await calculateSignature(
    HS_SECRET,
    JSON.stringify(payload)
  );

  // Verifying webhook signature
  if (hsSignature != calculatedSignature) {
    return new Response("Invalid signature", {
      status: 200,
    });
  }

  console.log(JSON.stringify(payload));

  return new Response(null, {
    status: 200,
  });
};

serve(handler, { port: PORT });
