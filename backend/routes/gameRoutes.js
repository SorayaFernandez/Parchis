const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const gameController = require('../controllers/gameController');

router.post('/', authMiddleware, gameController.createGame);
router.get('/:id', authMiddleware, gameController.getGame);

router.post('/:id/join', authMiddleware, gameController.joinGame);
router.post('/:id/roll', authMiddleware, gameController.rollDice);
router.post('/:id/move', authMiddleware, gameController.movePiece);
router.post('/:id/bonus', authMiddleware, gameController.moveBonusPiece);

module.exports = router;