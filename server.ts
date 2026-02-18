import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// 1. Initialisation du serveur MCP
const mcp = new McpServer({
  name: "mcp-http",
  version: "1.0.0"
});

// 2. Définition du schéma d'arguments
const WeatherArgs = {
  city: z.string().min(1).describe("Ville (ex: Paris)"),
  country: z.string().optional().describe("Code pays (ex: FR)"),
  lang: z.string().optional().describe("Langue (ex: fr)")
};

// 3. Définition de l'outil (Tool)
mcp.tool("realtime_weather", WeatherArgs, async ({ city, country, lang }) => {
  // Debug: On affiche ce que le serveur reçoit réellement
  console.log(`Requête reçue pour la ville : ${city}, pays : ${country}`);

  try {
    // Étape A: Géocodage (Trouver lat/long)
    const geoParams = new URLSearchParams({ name: city });
    if (country) geoParams.set("country_code", country);
    if (lang) geoParams.set("language", lang);

    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${geoParams.toString()}`);
    const geoJson = await geoRes.json() as any;

    if (!geoJson?.results?.length) {
      console.log(`Ville non trouvée par l'API : ${city}`);
      return {
        content: [{ type: "text", text: `Ville introuvable : ${city}` }],
        isError: true
      };
    }

    const { latitude, longitude, name, country_code } = geoJson.results[0];

    // Étape B: Météo
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
    console.log(`Réponse envoyée : ${message}`);

    return {
      content: [{ type: "text", text: message }]
    };
  } catch (error) {
    console.error("Erreur API:", error);
    return {
      content: [{ type: "text", text: "Erreur lors de la récupération météo." }],
      isError: true
    };
  }
});

// 4. Configuration Express
const app = express();
app.use(express.json());

// Transport obligatoire avec un objet vide {}
const transport = new StreamableHTTPServerTransport({});

// Route de santé pour Render (obligatoire pour éviter les erreurs 502)
app.get("/", (req, res) => {
  res.send("Serveur MCP Weather opérationnel !");
});

// Route pour AIro / MCP
app.post("/mcp", async (req, res) => {
  try {
    // Cette fonction du SDK s'occupe de router vers mcp.tool
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erreur MCP Request:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 5. Démarrage
const start = async () => {
  try {
    // Connexion vitale entre le serveur MCP et le transport HTTP
    await mcp.connect(transport);
    
    const port = Number(process.env.PORT || 3000);
    // 0.0.0.0 est impératif pour Render
    app.listen(port, "0.0.0.0", () => {
      console.log(`✅ Serveur MCP prêt sur le port ${port}`);
    });
  } catch (error) {
    console.error("Échec du démarrage:", error);
  }
};

start();