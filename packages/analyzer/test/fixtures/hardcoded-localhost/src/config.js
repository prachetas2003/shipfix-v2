// Multiple deployment smells: hardcoded local URLs that will break in prod.
const API_URL = "http://localhost:4000/api";
const WS_URL = "ws://localhost:4001";
const DB_ADMIN = "http://127.0.0.1:5432";

module.exports = { API_URL, WS_URL, DB_ADMIN };
