const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { pool } = require("../config/database");
const authenticate = require("../middleware/auth");

const router = express.Router();

// Middleware de validation
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Générer un JWT
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

// POST /auth/register - Inscription
router.post(
  "/register",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("Email invalide")
      .normalizeEmail(),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Le mot de passe doit faire au moins 6 caractères")
      .matches(/\d/)
      .withMessage("Le mot de passe doit contenir au moins un chiffre")
      .matches(/[A-Z]/)
      .withMessage("Le mot de passe doit contenir au moins une majuscule"),
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Le nom est requis")
      .isLength({ min: 2 })
      .withMessage("Le nom doit faire au moins 2 caractères"),
    validate,
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { email, password, name } = req.body;

      // Vérifier si l'email existe déjà
      const userCheck = await client.query(
        "SELECT 1 FROM users WHERE email = $1",
        [email]
      );

      if (userCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Cet email est déjà utilisé",
        });
      }

      // Hasher le mot de passe
      const hashedPassword = await bcrypt.hash(password, 12);

      // Créer l'utilisateur
      const result = await client.query(
        "INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name",
        [email, hashedPassword, name]
      );

      await client.query("COMMIT");

      // Générer le token
      const token = generateToken(result.rows[0].id);

      res.status(201).json({
        message: "Inscription réussie",
        user: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          name: result.rows[0].name,
        },
        token,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ message: "Erreur lors de l'inscription" });
    } finally {
      client.release();
    }
  }
);

// POST /auth/login - Connexion
router.post(
  "/login",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("Email invalide")
      .normalizeEmail(),
    body("password").notEmpty().withMessage("Le mot de passe est requis"),
    validate,
  ],
  async (req, res) => {
    try {
      const { email, password } = req.body;

      // Récupérer l'utilisateur
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [
        email,
      ]);

      if (result.rows.length === 0) {
        return res.status(401).json({
          message: "Email ou mot de passe incorrect",
        });
      }

      const user = result.rows[0];

      // Vérifier le mot de passe
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({
          message: "Email ou mot de passe incorrect",
        });
      }

      // Générer le token
      const token = generateToken(user.id);

      // Renvoyer l'utilisateur sans le mot de passe
      const { password: _, ...userWithoutPassword } = user;

      res.json({
        message: "Connexion réussie",
        user: userWithoutPassword,
        token,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Erreur lors de la connexion" });
    }
  }
);

// POST /auth/firebase-token - Mise à jour du token Firebase
router.post(
  "/firebase-token",
  [
    authenticate,
    body("token").notEmpty().withMessage("Le token Firebase est requis"),
    validate,
  ],
  async (req, res) => {
    try {
      await pool.query("UPDATE users SET firebase_token = $1 WHERE id = $2", [
        req.body.token,
        req.user.id,
      ]);

      res.json({ message: "Token Firebase mis à jour" });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la mise à jour du token Firebase" });
    }
  }
);

// GET /auth/me - Obtenir le profil utilisateur
router.get("/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, name, created_at FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Erreur lors de la récupération du profil" });
  }
});

// PUT /auth/me - Mettre à jour le profil
router.put(
  "/me",
  [
    authenticate,
    body("name")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Le nom ne peut pas être vide")
      .isLength({ min: 2 })
      .withMessage("Le nom doit faire au moins 2 caractères"),
    body("currentPassword")
      .optional()
      .notEmpty()
      .withMessage("Le mot de passe actuel est requis"),
    body("newPassword")
      .optional()
      .isLength({ min: 6 })
      .withMessage("Le nouveau mot de passe doit faire au moins 6 caractères")
      .matches(/\d/)
      .withMessage("Le nouveau mot de passe doit contenir au moins un chiffre")
      .matches(/[A-Z]/)
      .withMessage(
        "Le nouveau mot de passe doit contenir au moins une majuscule"
      ),
    validate,
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { name, currentPassword, newPassword } = req.body;

      // Récupérer l'utilisateur actuel
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1",
        [req.user.id]
      );

      const user = userResult.rows[0];

      // Si changement de mot de passe
      if (currentPassword && newPassword) {
        const validPassword = await bcrypt.compare(
          currentPassword,
          user.password
        );
        if (!validPassword) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: "Mot de passe actuel incorrect",
          });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await client.query("UPDATE users SET password = $1 WHERE id = $2", [
          hashedPassword,
          req.user.id,
        ]);
      }

      // Mise à jour du nom si fourni
      if (name) {
        await client.query("UPDATE users SET name = $1 WHERE id = $2", [
          name,
          req.user.id,
        ]);
      }

      await client.query("COMMIT");

      // Récupérer l'utilisateur mis à jour
      const updatedUser = await client.query(
        "SELECT id, email, name, created_at FROM users WHERE id = $1",
        [req.user.id]
      );

      res.json({
        message: "Profil mis à jour avec succès",
        user: updatedUser.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la mise à jour du profil" });
    } finally {
      client.release();
    }
  }
);

// DELETE /auth/me - Supprimer le compte
router.delete(
  "/me",
  [
    authenticate,
    body("password")
      .notEmpty()
      .withMessage("Le mot de passe est requis pour supprimer le compte"),
    validate,
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Vérifier le mot de passe
      const userResult = await client.query(
        "SELECT password FROM users WHERE id = $1",
        [req.user.id]
      );

      const validPassword = await bcrypt.compare(
        req.body.password,
        userResult.rows[0].password
      );

      if (!validPassword) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Mot de passe incorrect",
        });
      }

      // Supprimer les items de l'utilisateur
      await client.query("DELETE FROM party_items WHERE user_id = $1", [
        req.user.id,
      ]);

      // Supprimer les participations
      await client.query("DELETE FROM party_participants WHERE user_id = $1", [
        req.user.id,
      ]);

      // Supprimer les soirées créées
      await client.query("DELETE FROM parties WHERE creator_id = $1", [
        req.user.id,
      ]);

      // Supprimer l'utilisateur
      await client.query("DELETE FROM users WHERE id = $1", [req.user.id]);

      await client.query("COMMIT");
      res.json({ message: "Compte supprimé avec succès" });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la suppression du compte" });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
