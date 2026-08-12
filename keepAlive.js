const express = require("express");

function keepAlive(client) {
  const app = express();

  app.get("/", (req, res) => {
    res.send(
      `Lotus est en ligne. Ping: ${client.ws.ping}ms | Serveurs: ${client.guilds.cache.size}`
    );
  });

  // Endpoint dédié pour UptimeRobot (retourne juste un statut clair)
  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      guilds: client.guilds.cache.size,
      ping: client.ws.ping,
    });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[KeepAlive] Serveur web actif sur le port ${port}.`);
  });
}

module.exports = { keepAlive };
