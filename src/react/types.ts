export interface ReactComponent {
  id: string;
  name: string;                    // PascalCase component name
  path: string;                    // file path where component should live
  routePath?: string;              // React Router path (e.g., '/dashboard')
  code: string;                    // Full TSX source code
  dependencies: string[];          // npm package names used (e.g., ['react-router-dom'])
  isPage: boolean;                 // true if this is a top-level page/route
  consistencyHash: string;         // sha256 of props/exports to detect breaking changes
  createdAt: number;
  updatedAt: number;
  version: number;                 // increments on updates
  backwardCompatible: boolean;     // does this update break existing callers?
  supersedes?: string;             // ID of the previous version this replaces
  metadata?: Record<string, any>;
}

export interface FrontendRouteConfig {
  path: string;                    // React Router path
  componentName: string;
  componentId: string;
  lazy: boolean;                   // use React.lazy for code splitting
  exact?: boolean;
  children?: FrontendRouteConfig[];
}

export interface ConsistencyCheck {
  passed: boolean;
  issues: {
    type: 'breaking_export' | 'missing_prop' | 'type_change' | 'route_conflict';
    description: string;
    severity: 'error' | 'warning';
  }[];
}

export type ReactAppFramework = 'react' | 'vite' | 'next' | 'unknown';
export type ReactRouterKind = 'react-router' | 'next-app' | 'next-pages' | 'unknown';

/** Non-secret application facts supplied to the generator and repository planner. */
export interface ReactApplicationContext {
  framework: ReactAppFramework;
  router: ReactRouterKind;
  entrypoint?: string;
  routesFile?: string;
  appDirectory?: string;
  pagesDirectory?: string;
  dependencies: string[];
  stylingLibraries: string[];
  stateLibraries: string[];
  dataLibraries: string[];
  existingRoutes: string[];
}

export interface ComponentRequest {
  name: string;           // PascalCase component name
  routePath?: string;     // React Router path
  intent: string;         // what this component should do / show
  dataEndpoints?: string[]; // API endpoints this component will call
  isPage?: boolean;       // if true, register as a Route
  styleHints?: string;    // visual description/hints
  parentComponent?: string; // name of parent component to nest within
  applicationContext?: ReactApplicationContext;
}
