const express = require('express');

const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const friendsController = require('../controllers/friendsController');

router.use(authMiddleware);

router.get('/', friendsController.getFriends);
router.get('/requests', friendsController.getPendingRequests);
router.post('/request/:id', friendsController.sendRequest);
router.post('/accept/:id', friendsController.acceptRequest);
router.delete('/:id', friendsController.removeFriend);

module.exports = router;