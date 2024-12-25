const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../config/database");
const authenticate = require("../middleware/auth");
const { sendPushNotification } = require("../config/firebase");

const router = express.Router();

// Middleware de validation
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// GET /parties - Obtenir toutes les soirées
router.get("/", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        p.*, 
        u.name as creator_name,
        (SELECT json_agg(
          json_build_object(
            'id', pi.id,
            'name', pi.name,
            'quantity', pi.quantity,
            'description', pi.description,
            'category', pi.category,
            'user_id', pi.user_id,
            'created_at', pi.created_at,
            'updated_at', pi.updated_at,
            'brought_by', u2.name
          )
        )
        FROM party_items pi
        JOIN users u2 ON pi.user_id = u2.id
        WHERE pi.party_id = p.id) as items,
        (SELECT json_agg(
          json_build_object(
            'id', u3.id,
            'name', u3.name,
            'email', u3.email,
            'created_at', u3.created_at
          )
        )
        FROM party_participants pp
        JOIN users u3 ON pp.user_id = u3.id
        WHERE pp.party_id = p.id) as participants
      FROM parties p 
      JOIN users u ON p.creator_id = u.id
      WHERE p.id IN (
        SELECT party_id FROM party_participants WHERE user_id = $1
      )
      OR p.creator_id = $1
      ORDER BY p.date`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Erreur lors de la récupération des soirées" });
  }
});

// POST /parties - Créer une nouvelle soirée
router.post(
  "/",
  [
    authenticate,
    body("name").trim().notEmpty().withMessage("Le nom est requis"),
    body("date").isISO8601().withMessage("La date doit être au format ISO8601"),
    body("location").trim().notEmpty().withMessage("Le lieu est requis"),
    validate,
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { name, date, location, description } = req.body;

      const partyResult = await client.query(
        `INSERT INTO parties (
          name, 
          date, 
          location, 
          description, 
          creator_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        RETURNING *,
        (SELECT name FROM users WHERE id = $5) as creator_name`,
        [name, date, location, description, req.user.id]
      );

      await client.query(
        "INSERT INTO party_participants (party_id, user_id) VALUES ($1, $2)",
        [partyResult.rows[0].id, req.user.id]
      );

      await client.query("COMMIT");
      res.status(201).json(partyResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la création de la soirée" });
    } finally {
      client.release();
    }
  }
);

// GET /parties/:id - Obtenir une soirée spécifique
router.get(
  "/:id",
  [authenticate, param("id").isInt().withMessage("ID invalide"), validate],
  async (req, res) => {
    try {
      const partyResult = await pool.query(
        `SELECT p.*, u.name as creator_name,
       (SELECT json_agg(json_build_object(
         'id', pi.id,
         'name', pi.name,
         'quantity', pi.quantity,
         'brought_by', u2.name
       ))
       FROM party_items pi
       JOIN users u2 ON pi.user_id = u2.id
       WHERE pi.party_id = p.id) as items,
       (SELECT json_agg(json_build_object(
         'id', u3.id,
         'name', u3.name,
         'email', u3.email
       ))
       FROM party_participants pp
       JOIN users u3 ON pp.user_id = u3.id
       WHERE pp.party_id = p.id) as participants
       FROM parties p 
       JOIN users u ON p.creator_id = u.id 
       WHERE p.id = $1`,
        [req.params.id]
      );

      if (partyResult.rows.length === 0) {
        return res.status(404).json({ message: "Soirée non trouvée" });
      }

      // Vérifier que l'utilisateur est participant ou créateur
      const isParticipant = partyResult.rows[0].participants?.some(
        (p) => p.id === req.user.id
      );
      const isCreator = partyResult.rows[0].creator_id === req.user.id;

      if (!isParticipant && !isCreator) {
        return res.status(403).json({ message: "Accès non autorisé" });
      }

      res.json(partyResult.rows[0]);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la récupération de la soirée" });
    }
  }
);

// PUT /parties/:id - Mettre à jour une soirée
router.put(
  "/:id",
  [
    authenticate,
    param("id").isInt().withMessage("ID invalide"),
    body("name")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Le nom ne peut pas être vide"),
    body("date").optional().isISO8601().withMessage("Format de date invalide"),
    body("location")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Le lieu ne peut pas être vide"),
    validate,
  ],
  async (req, res) => {
    const { id } = req.params;
    const { name, date, location, description } = req.body;

    try {
      // Vérifier que l'utilisateur est le créateur
      const partyCheck = await pool.query(
        "SELECT creator_id, name as party_name FROM parties WHERE id = $1",
        [id]
      );

      if (partyCheck.rows.length === 0) {
        return res.status(404).json({ message: "Soirée non trouvée" });
      }

      if (partyCheck.rows[0].creator_id !== req.user.id) {
        return res.status(403).json({ message: "Non autorisé" });
      }

      const result = await pool.query(
        `UPDATE parties 
        SET name = COALESCE($1, name),
            date = COALESCE($2, date),
            location = COALESCE($3, location),
            description = COALESCE($4, description),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING *,
        (SELECT name FROM users WHERE id = creator_id) as creator_name`,
        [name, date, location, description, id]
      );

      // Notifier les participants
      const tokens = await pool.query(
        "SELECT firebase_token FROM users u JOIN party_participants p ON u.id = p.user_id WHERE p.party_id = $1 AND u.id != $2",
        [id, req.user.id]
      );

      if (tokens.rows.length > 0) {
        await sendPushNotification(
          tokens.rows.map((t) => t.firebase_token).filter(Boolean),
          "Soirée modifiée",
          `La soirée "${partyCheck.rows[0].party_name}" a été mise à jour`
        );
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la mise à jour de la soirée" });
    }
  }
);

// DELETE /parties/:id - Supprimer une soirée
router.delete(
  "/:id",
  [authenticate, param("id").isInt().withMessage("ID invalide"), validate],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Vérifier que l'utilisateur est le créateur
      const partyCheck = await client.query(
        "SELECT creator_id FROM parties WHERE id = $1",
        [req.params.id]
      );

      if (partyCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Soirée non trouvée" });
      }

      if (partyCheck.rows[0].creator_id !== req.user.id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Non autorisé" });
      }

      // Supprimer les items
      await client.query("DELETE FROM party_items WHERE party_id = $1", [
        req.params.id,
      ]);

      // Supprimer les participants
      await client.query("DELETE FROM party_participants WHERE party_id = $1", [
        req.params.id,
      ]);

      // Supprimer la soirée
      await client.query("DELETE FROM parties WHERE id = $1", [req.params.id]);

      await client.query("COMMIT");
      res.status(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la suppression de la soirée" });
    } finally {
      client.release();
    }
  }
);

// POST /parties/:id/participants - Ajouter un participant
router.post(
  "/:id/participants",
  [
    authenticate,
    param("id").isInt().withMessage("ID invalide"),
    body("userId").isInt().withMessage("ID utilisateur invalide"),
    validate,
  ],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { userId } = req.body;

      // Vérifier que la soirée existe
      const partyCheck = await pool.query(
        "SELECT name FROM parties WHERE id = $1",
        [id]
      );

      if (partyCheck.rows.length === 0) {
        return res.status(404).json({ message: "Soirée non trouvée" });
      }

      // Vérifier si l'utilisateur n'est pas déjà participant
      const participantCheck = await pool.query(
        "SELECT 1 FROM party_participants WHERE party_id = $1 AND user_id = $2",
        [id, userId]
      );

      if (participantCheck.rows.length > 0) {
        return res
          .status(400)
          .json({ message: "L'utilisateur est déjà participant" });
      }

      await pool.query(
        "INSERT INTO party_participants (party_id, user_id) VALUES ($1, $2)",
        [id, userId]
      );

      // Récupérer les informations de l'utilisateur ajouté
      const userInfo = await pool.query(
        "SELECT name FROM users WHERE id = $1",
        [userId]
      );

      // Notifier les autres participants
      const tokens = await pool.query(
        "SELECT firebase_token FROM users u JOIN party_participants p ON u.id = p.user_id WHERE p.party_id = $1 AND u.id != $2",
        [id, userId]
      );

      if (tokens.rows.length > 0) {
        await sendPushNotification(
          tokens.rows.map((t) => t.firebase_token).filter(Boolean),
          "Nouveau participant",
          `${userInfo.rows[0].name} a rejoint la soirée "${partyCheck.rows[0].name}"`
        );
      }

      res.status(201).json({
        message: "Participant ajouté avec succès",
        participant: {
          id: userId,
          name: userInfo.rows[0].name,
        },
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de l'ajout du participant" });
    }
  }
);

// DELETE /parties/:id/participants/:userId - Supprimer un participant
router.delete(
  "/:id/participants/:userId",
  [
    authenticate,
    param("id").isInt().withMessage("ID soirée invalide"),
    param("userId").isInt().withMessage("ID utilisateur invalide"),
    validate,
  ],
  async (req, res) => {
    try {
      const { id, userId } = req.params;

      // Vérifier que l'utilisateur est le créateur ou se retire lui-même
      if (userId !== req.user.id) {
        const partyCheck = await pool.query(
          "SELECT creator_id FROM parties WHERE id = $1",
          [id]
        );

        if (partyCheck.rows[0].creator_id !== req.user.id) {
          return res.status(403).json({ message: "Non autorisé" });
        }
      }

      const result = await pool.query(
        "DELETE FROM party_participants WHERE party_id = $1 AND user_id = $2",
        [id, userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Participant non trouvé" });
      }

      res.status(204).send();
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la suppression du participant" });
    }
  }
);

// POST /parties/:id/items - Ajouter un item
router.post(
  "/:id/items",
  [
    body("name").trim().notEmpty().withMessage("Le nom est requis"),
    body("quantity")
      .isInt({ min: 1 })
      .withMessage("La quantité doit être supérieure à 0"),
    body("category")
      .optional()
      .isIn([
        "Boissons",
        "Nourriture",
        "Desserts",
        "Snacks",
        "Décorations",
        "Ustensiles",
        "Autres",
      ])
      .withMessage("Catégorie invalide"),
    body("description")
      .optional()
      .isLength({ max: 500 })
      .withMessage("La description ne peut pas dépasser 500 caractères"),
    validate,
  ],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, quantity } = req.body;

      // Vérifier que l'utilisateur est participant
      const participantCheck = await pool.query(
        "SELECT 1 FROM party_participants WHERE party_id = $1 AND user_id = $2",
        [id, req.user.id]
      );

      if (participantCheck.rows.length === 0) {
        return res.status(403).json({
          message: "Vous devez être participant pour ajouter un item",
        });
      }

      const result = await pool.query(
        `INSERT INTO party_items (
          party_id, 
          user_id, 
          name, 
          quantity,
          description,
          category,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING *,
        (SELECT name FROM users WHERE id = $2) as brought_by`,
        [
          id,
          req.user.id,
          name,
          quantity,
          req.body.description || null,
          req.body.category || null,
        ]
      );

      // Notifier les autres participants
      const tokens = await pool.query(
        "SELECT u.firebase_token, p.name as party_name FROM users u JOIN party_participants pp ON u.id = pp.user_id JOIN parties p ON p.id = pp.party_id WHERE pp.party_id = $1 AND u.id != $2",
        [id, req.user.id]
      );

      if (tokens.rows.length > 0) {
        await sendPushNotification(
          tokens.rows.map((t) => t.firebase_token).filter(Boolean),
          "Nouvel item ajouté",
          `${result.rows[0].brought_by} apporte ${quantity} ${name} à la soirée "${tokens.rows[0].party_name}"`
        );
      }

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Erreur lors de l'ajout de l'item" });
    }
  }
);

// PUT /parties/:id/items/:itemId - Mettre à jour un item
router.put(
  "/:id/items/:itemId",
  [
    authenticate,
    param("id").isInt().withMessage("ID soirée invalide"),
    param("itemId").isInt().withMessage("ID item invalide"),
    body("name")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Le nom ne peut pas être vide"),
    body("quantity")
      .optional()
      .isInt({ min: 1 })
      .withMessage("La quantité doit être supérieure à 0"),
    validate,
  ],
  async (req, res) => {
    try {
      const { id, itemId } = req.params;
      const { name, quantity } = req.body;

      // Vérifier que l'item appartient à l'utilisateur
      const itemCheck = await pool.query(
        "SELECT user_id FROM party_items WHERE id = $1 AND party_id = $2",
        [itemId, id]
      );

      if (itemCheck.rows.length === 0) {
        return res.status(404).json({ message: "Item non trouvé" });
      }

      if (itemCheck.rows[0].user_id !== req.user.id) {
        return res.status(403).json({ message: "Non autorisé" });
      }

      const result = await pool.query(
        `UPDATE party_items
       SET name = COALESCE($1, name),
           quantity = COALESCE($2, quantity),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND party_id = $4
       RETURNING *,
       (SELECT name FROM users WHERE id = user_id) as brought_by`,
        [name, quantity, itemId, id]
      );

      // Notifier les autres participants
      const tokens = await pool.query(
        "SELECT u.firebase_token, p.name as party_name FROM users u JOIN party_participants pp ON u.id = pp.user_id JOIN parties p ON p.id = pp.party_id WHERE pp.party_id = $1 AND u.id != $2",
        [id, req.user.id]
      );

      if (tokens.rows.length > 0) {
        await sendPushNotification(
          tokens.rows.map((t) => t.firebase_token).filter(Boolean),
          "Item modifié",
          `${result.rows[0].brought_by} a modifié son item dans la soirée "${tokens.rows[0].party_name}"`
        );
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la mise à jour de l'item" });
    }
  }
);

// DELETE /parties/:id/items/:itemId - Supprimer un item
router.delete(
  "/:id/items/:itemId",
  [
    authenticate,
    param("id").isInt().withMessage("ID soirée invalide"),
    param("itemId").isInt().withMessage("ID item invalide"),
    validate,
  ],
  async (req, res) => {
    try {
      const { id, itemId } = req.params;

      // Vérifier que l'item appartient à l'utilisateur
      const itemCheck = await pool.query(
        "SELECT user_id, name FROM party_items WHERE id = $1 AND party_id = $2",
        [itemId, id]
      );

      if (itemCheck.rows.length === 0) {
        return res.status(404).json({ message: "Item non trouvé" });
      }

      if (itemCheck.rows[0].user_id !== req.user.id) {
        return res.status(403).json({ message: "Non autorisé" });
      }

      await pool.query(
        "DELETE FROM party_items WHERE id = $1 AND party_id = $2",
        [itemId, id]
      );

      // Notifier les autres participants
      const tokens = await pool.query(
        "SELECT u.firebase_token, p.name as party_name FROM users u JOIN party_participants pp ON u.id = pp.user_id JOIN parties p ON p.id = pp.party_id WHERE pp.party_id = $1 AND u.id != $2",
        [id, req.user.id]
      );

      if (tokens.rows.length > 0) {
        await sendPushNotification(
          tokens.rows.map((t) => t.firebase_token).filter(Boolean),
          "Item supprimé",
          `Un item a été retiré de la soirée "${tokens.rows[0].party_name}"`
        );
      }

      res.status(204).send();
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Erreur lors de la suppression de l'item" });
    }
  }
);

module.exports = router;
