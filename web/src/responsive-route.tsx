import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useIsMobile } from '@/i18n';
import { matchMobileRoute, mobileRoutePath } from '@/mobile/mobile-route-manifest';

/** Translate only when the current route belongs to the other layout. Unknown or desktop-only
 * pages fall back to the destination home; the shared provider setup lives outside this guard. */
export function layoutDestination(pathname: string, mobile: boolean): string {
  if (mobile) {
    switch (pathname.replace(/\/+$/, '')) {
      case '/tasks': return mobileRoutePath('tasks');
      case '/threads': return mobileRoutePath('threads');
      case '/memory': return mobileRoutePath('memory');
      case '/overview': return mobileRoutePath('project');
      default: return mobileRoutePath('sessions');
    }
  }
  switch (matchMobileRoute(pathname)?.route.id) {
    case 'tasks':
    case 'task': return '/tasks';
    case 'threads':
    case 'thread': return '/threads';
    case 'memory':
    case 'memoryFile': return '/memory';
    case 'project': return '/overview';
    default: return '/workbench';
  }
}

/** One browser/hash router owns history for both layouts. A resize changes only the layout guard,
 * not the router instance, so deep links and back/forward never read an inactive router's state. */
export function ResponsiveRoute({ mobile, children }: { mobile: boolean; children: ReactNode }) {
  const isMobile = useIsMobile();
  const location = useLocation();
  if (isMobile !== mobile) {
    return <Navigate to={layoutDestination(location.pathname, isMobile)} replace />;
  }
  return children;
}
