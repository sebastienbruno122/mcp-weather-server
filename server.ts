import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const mcp = new McpServer({
  name: "mcp-http",
  version: "1.0.0"
});


// ...

/**
 * Tool: realtime_weather
 * Entrée: city (obligatoire), country (optionnel, ex: "FR"), lang (optionnel, ex: "fr")
 * Sortie: JSON structuré (température, vent, etc.)
 */
mcp.tool("realtime_weather", {
  description: "Retourne la météo actuelle pour une ville donnée (temps réel, via Open-Meteo)",
  inputSchema: z.object({
    city: z.string().min(1),
    country: z.string().optional(), // "FR", "CH", ...
    lang: z.string().optional()     // "fr", "en", ...
  })
}, async ({ city, country, lang }) => {
  // 1) Géocodage -> lat/lon
  const geoParams = new URLSearchParams({ name: city });
  if (country) geoParams.set("country_code", country);
  if (lang)    geoParams.set("language", lang);

  const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${geoParams.toString()}`);
  if (!geoRes.ok) throw new Error(`Geocoding failed: ${geoRes.status}`);
  const geoJson = await geoRes.json();

  if (!geoJson?.results?.length) {
    return { content: [{ type: "text", text: `Ville introuvable: ${city}${country ? " ("+country+")" : ""}` }] };
  }

  const { latitude, longitude, name, country_code } = geoJson.results[0];

  // 2) Appel météo "current"
  // Doc générale API: https://open-meteo.com/en/docs  (pas de clé requise)
  const meteoParams = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    // variables "current" : adapte selon ton besoin (temp, vent, pluie, etc.)
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    timezone: "auto"
  });

  const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?${meteoParams.toString()}`);
  if (!wxRes.ok) throw new Error(`Weather failed: ${wxRes.status}`);
  const wxJson = await wxRes.json();

  const current = wxJson?.current ?? {};
  const out = {
    city: name,
    country: country_code,
    latitude,
    longitude,
    observed_at: current?.time,
    temperature_c: current?.temperature_2m,
    humidity_pct: current?.relative_humidity_2m,
    wind_speed_ms: current?.wind_speed_10m,
    weather_code: current?.weather_code
  };

  return {
    // Texte lisible par tout client
    content: [{
      type: "text",
      text: `Météo actuelle à ${out.city} (${out.country}) — ${out.temperature_c}°C, vent ${out.wind_speed_ms} m/s, humidité ${out.humidity_pct}% à ${out.observed_at}`
    }],
    // Et version structurée (idéale pour un VoiceBot)
    structuredContent: out
  };
});

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => transport.close());

  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`MCP HTTP prêt sur http://localhost:${port}/mcp`);
});

