const axios = require("axios");

const requestInstance = axios.create({ timeout: 1000 });

requestInstance.interceptors.response.use((response) => response.data);

module.exports = { request: requestInstance };
