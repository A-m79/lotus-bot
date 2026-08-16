const express = require("express");

function keepAlive(client) {
  const app = express();

  app.get("/", (req, res) => {
    res.send(
      `Lotus is online. Ping: ${client.ws.ping}ms | Servers: ${client.guilds.cache.size}`
    );
  });

  // Dedicated endpoint for UptimeRobot (just returns a clear status)
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
    console.log(`[KeepAlive] Web server active on port ${port}.`);
  });
}

module.exports = { keepAlive };
