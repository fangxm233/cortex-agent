// Module resolve hook registered by ./register.mjs. Runs on Node's loader thread.

const BUILTIN_DIR_URL = new URL('../', import.meta.url).href;
let userDirUrl = null;

export function initialize(data) {
  userDirUrl = typeof data?.userDirUrl === 'string' ? data.userDirUrl : null;
}

function fallsBack(error, specifier, parentURL) {
  return error?.code === 'ERR_MODULE_NOT_FOUND'
    && (specifier.startsWith('./') || specifier.startsWith('../'))
    && userDirUrl !== null
    && typeof parentURL === 'string'
    && parentURL.startsWith(userDirUrl);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!fallsBack(error, specifier, context.parentURL)) throw error;
    const parentURL = new URL(context.parentURL.slice(userDirUrl.length), BUILTIN_DIR_URL).href;
    return nextResolve(specifier, { ...context, parentURL });
  }
}
