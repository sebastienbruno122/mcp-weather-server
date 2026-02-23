import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const streamableTransports: Map<string, StreamableHTTPServerTransport> = new Map();
const sseTransports: Map<string, SSEServerTransport> = new Map();

function createServer() {
  const mcp = new McpServer({
    name: "mcp-http",
    version: "1.0.0"
  });

  const WeatherArgs = {
    city: z.string().min(1).describe("Ville (ex: Paris)"),
    country: z.string().optional().describe("Code pays (ex: FR)"),
    lang: z.string().optional().describe("Langue (ex: fr)")
  };

  mcp.tool("realtime_weather", WeatherArgs, async ({ city, country, lang }) => {
    console.log(`Request received for city: ${city}, country: ${country}`);

    try {
      const geoParams = new URLSearchParams({ name: city });
      if (country) geoParams.set("country_code", country);
      if (lang) geoParams.set("language", lang);

      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${geoParams.toString()}`);
      const geoJson = await geoRes.json() as any;

      if (!geoJson?.results?.length) {
        console.log(`City not found: ${city}`);
        return {
          content: [{ type: "text" as const, text: `Ville introuvable : ${city}` }],
          isError: true
        };
      }

      const { latitude, longitude, name, country_code } = geoJson.results[0];

      const meteoParams = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,relative_humidity_2m",
        timezone: "auto"
      });

      const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?${meteoParams.toString()}`);
      const wxJson = await wxRes.json() as any;
      const current = wxJson?.current ?? {};

      const message = `Météo à ${name} (${country_code}): ${current?.temperature_2m}°C, ${current?.relative_humidity_2m}% d'humidité.`;
      console.log(`Response sent: ${message}`);

      return {
        content: [{ type: "text" as const, text: message }]
      };
    } catch (error) {
      console.error("API error:", error);
      return {
        content: [{ type: "text" as const, text: "Erreur lors de la récupération météo." }],
        isError: true
      };
    }
  });

  return mcp;
}

app.get("/", (_req, res) => {
  res.send("Serveur MCP Weather opérationnel !");
});

// =================== SSE TRANSPORT ===================

app.get("/sse", async (req, res) => {
  console.log("SSE connection opened");
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);
  console.log(`SSE session created: ${sessionId}`);

  const mcp = createServer();

  res.on("close", () => {
    sseTransports.delete(sessionId);
    console.log(`SSE session closed: ${sessionId}`);
  });

  await mcp.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId || !sseTransports.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid session ID" });
    return;
  }

  const transport = sseTransports.get(sessionId)!;
  await transport.handlePostMessage(req, res, req.body);
});

// =================== STREAMABLE HTTP TRANSPORT ===================

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && streamableTransports.has(sessionId)) {
      const transport = streamableTransports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) streamableTransports.delete(sid);
      console.log(`Streamable session closed: ${sid}`);
    };

    const mcp = createServer();
    await mcp.connect(transport);

    if (transport.sessionId) {
      streamableTransports.set(transport.sessionId, transport);
      console.log(`Streamable session created: ${transport.sessionId}`);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !streamableTransports.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid session ID" });
    return;
  }

  const transport = streamableTransports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !streamableTransports.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid session ID" });
    return;
  }

  const transport = streamableTransports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP server ready on port ${port}`);
  console.log(`  Streamable HTTP: POST/GET/DELETE /mcp`);
  console.log(`  SSE: GET /sse + POST /messages`);
});