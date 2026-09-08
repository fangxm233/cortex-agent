// input:  tRPC core and procedure error shapes
// output: router, publicProcedure and createCallerFactory
// pos:    UI router foundation with credential-error redaction
// >>> Once updated, update this header and parent CORTEX.md <<<

import { initTRPC } from '@trpc/server';

const t = initTRPC.create({
  errorFormatter({ shape, path }) {
    if (path !== 'config.setPlatform') return shape;
    return { ...shape, message: 'Platform configuration request failed',
      data: { ...shape.data, stack: undefined } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
