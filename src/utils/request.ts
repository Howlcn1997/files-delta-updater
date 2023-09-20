import axios from "axios";

const requestInstance = axios.create({ timeout: 1000 });

requestInstance.interceptors.response.use((response) => response.data);

export const request = requestInstance;
