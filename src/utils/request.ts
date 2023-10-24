export function requestInstanceCreate(axios) {
  const requestInstance = axios.create({ timeout: 6000 });

  requestInstance.interceptors.response.use((response) => response.data);

  return requestInstance;
}
