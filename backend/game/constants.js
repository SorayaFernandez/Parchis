const COLORS = [ "pink", "purple", "green", "blue"];
const TURN_ORDER = ["pink", "blue", "purple", "green"];
const GAME_STATUS = { WAITING: "waiting", PLAYING: "playing", PAUSED: "paused", FINISHED: "finished" };
const MAIN_TRACK_SIZE = 68;
const FINAL_STRETCH_SIZE = 7;
const FINAL_POSITION = MAIN_TRACK_SIZE + FINAL_STRETCH_SIZE;
const START_POSITIONS = { pink: 39, purple: 5, green: 22, blue: 56 };
const SAFE_CELLS = [0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63, 68];
const BASE_POSITION = -1;
const FINAL_STRETCH_START = MAIN_TRACK_SIZE;
const DISCONNECT_TIMEOUT = 30000;
const TURN_TIMEOUT = 60000;
const CAPTURE_BONUS = 20;
const GOAL_BONUS = 10;
const HOME_ENTRIES = { pink: 34, purple: 68, green: 17, blue: 51 };

module.exports = { COLORS, TURN_ORDER, GAME_STATUS, MAIN_TRACK_SIZE, FINAL_STRETCH_SIZE, FINAL_POSITION, FINAL_STRETCH_START, BASE_POSITION, START_POSITIONS, SAFE_CELLS, HOME_ENTRIES, DISCONNECT_TIMEOUT, TURN_TIMEOUT, CAPTURE_BONUS, GOAL_BONUS };