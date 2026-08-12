const mongoose = require("mongoose");

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI manquant dans les variables d'environnement.");
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });

  console.log("[DB] Connecté à MongoDB Atlas.");

  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Déconnecté de MongoDB, tentative de reconnexion...");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[DB] Erreur MongoDB:", err);
  });
}

module.exports = { connectDatabase };
