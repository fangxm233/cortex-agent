import { createBrowserRouter, createHashRouter } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';
import { mobileRoutes } from './mobile-routes';

// The concrete mobile router instance (browser / hash by shell mode, mirroring the desktop router).
// Route config lives in `mobile-routes` so it stays inspectable without a browser history.
// Native shells (desktop OR Android) load over an asset protocol at `/index.html` → HashRouter.
const createRouter = isNativeShell() ? createHashRouter : createBrowserRouter;

export const mobileRouter = createRouter(mobileRoutes);
