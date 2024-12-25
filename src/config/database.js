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
        -- Table utilisateurs
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          firebase_token TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE
        );

        -- Table des soirées
        CREATE TABLE IF NOT EXISTS parties (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          date TIMESTAMP WITH TIME ZONE NOT NULL,
          location VARCHAR(255) NOT NULL,
          description TEXT,
          creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE,
          -- Vérification que la date est dans le futur
          CONSTRAINT future_date CHECK (date > CURRENT_TIMESTAMP)
        );

        -- Table des participants
        CREATE TABLE IF NOT EXISTS party_participants (
          party_id INTEGER REFERENCES parties(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (party_id, user_id)
        );

        -- Table des items
        CREATE TABLE IF NOT EXISTS party_items (
          id SERIAL PRIMARY KEY,
          party_id INTEGER REFERENCES parties(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          quantity INTEGER NOT NULL,
          category VARCHAR(50),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE,
          -- Vérification que la quantité est positive
          CONSTRAINT positive_quantity CHECK (quantity > 0),
          -- Vérification de la catégorie
          CONSTRAINT valid_category CHECK (
            category IN ('Boissons', 'Nourriture', 'Desserts', 'Snacks', 'Décorations', 'Ustensiles', 'Autres')
          )
        );

        -- Fonction pour mettre à jour automatiquement updated_at
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';

        -- Triggers pour updated_at
        DROP TRIGGER IF EXISTS update_users_updated_at ON users;
        CREATE TRIGGER update_users_updated_at
          BEFORE UPDATE ON users
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();

        DROP TRIGGER IF EXISTS update_parties_updated_at ON parties;
        CREATE TRIGGER update_parties_updated_at
          BEFORE UPDATE ON parties
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();

        DROP TRIGGER IF EXISTS update_party_items_updated_at ON party_items;
        CREATE TRIGGER update_party_items_updated_at
          BEFORE UPDATE ON party_items
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();

        -- Index pour améliorer les performances
        CREATE INDEX IF NOT EXISTS idx_parties_date ON parties(date);
        CREATE INDEX IF NOT EXISTS idx_parties_creator_id ON parties(creator_id);
        CREATE INDEX IF NOT EXISTS idx_party_items_party_id ON party_items(party_id);
        CREATE INDEX IF NOT EXISTS idx_party_items_user_id ON party_items(user_id);
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
