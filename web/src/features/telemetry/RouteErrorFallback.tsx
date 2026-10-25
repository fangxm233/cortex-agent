import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { reportRenderError } from './crash-capture';
import { CrashFallback } from './RootErrorBoundary';

/**
 * The app router's error element. A data router catches every error thrown while rendering a
 * route, so without this those errors would show the router's developer page and never reach
 * the root boundary. A route error response (an unmatched URL) is not a crash and is not reported.
 */
export function RouteErrorFallback() {
  const error = useRouteError();
  useEffect(() => {
    if (!isRouteErrorResponse(error)) reportRenderError(error, null);
  }, [error]);
  return <CrashFallback />;
}
