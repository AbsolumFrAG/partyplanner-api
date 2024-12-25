require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth.js");
const partyRoutes = require("./routes/parties.js");
const { initializeFirebase } = require("./config/firebase.js");
const { initializeDatabase } = require("./config/database.js");

const app = express();
app.use(cors());
app.use(express.json());

initializeFirebase();

app.use("/api/auth", authRoutes);
app.use("/api/parties", partyRoutes);

const PORT = process.env.PORT || 3000;

// Initialisation de la base de données et démarrage du serveur
const startServer = async () => {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
