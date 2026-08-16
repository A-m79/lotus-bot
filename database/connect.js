const mongoose = require("mongoose");

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is missing from the environment variables.");
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });

  console.log("[DB] Connected to MongoDB Atlas.");

  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Disconnected from MongoDB, attempting to reconnect...");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[DB] MongoDB Error:", err);
  });
}

module.exports = { connectDatabase };
