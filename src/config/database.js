const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const initializeDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          firebase_token TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
  
        CREATE TABLE IF NOT EXISTS parties (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          date TIMESTAMP WITH TIME ZONE NOT NULL,
          location VARCHAR(255) NOT NULL,
          description TEXT,
          creator_id INTEGER REFERENCES users(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
  
        CREATE TABLE IF NOT EXISTS party_participants (
          party_id INTEGER REFERENCES parties(id),
          user_id INTEGER REFERENCES users(id),
          PRIMARY KEY (party_id, user_id)
        );
  
        CREATE TABLE IF NOT EXISTS party_items (
          id SERIAL PRIMARY KEY,
          party_id INTEGER REFERENCES parties(id),
          user_id INTEGER REFERENCES users(id),
          name VARCHAR(255) NOT NULL,
          quantity INTEGER NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
    console.log("Base de données initialisée avec succès");
  } catch (error) {
    console.error(
      "Erreur lors de l'initialisation de la base de données:",
      error
    );
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { pool, initializeDatabase };
