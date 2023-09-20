export function createProxy(target, errorHandle) {
  const proxy = createExceptionProxy(errorHandle);
  return new Proxy(target, { get: proxy });
}

export function createExceptionProxy(errorHandle) {
  return (target, prop) => {
    if (!(prop in target)) return;

    if (typeof target[prop] === "function") {
      return (...args) => {
        try {
          const result = target[prop](...args);
          if (result instanceof Promise) {
            return result.catch(errorHandle);
          }
          return result;
        } catch (error) {
          errorHandle(error);
        }
      };
    }

    return target[prop];
  };
}
