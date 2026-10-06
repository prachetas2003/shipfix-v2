const key = process.env.TEST_ONLY_API_KEY;
fetch("http://localhost:8080/api/healthz", { headers: { authorization: `Bearer ${key}` } });
