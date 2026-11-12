import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { docsetsFor, pageFor, pickerFor, sidebarFor, topicsFor } from './versioning';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const page = pageFor(route.id);
  if (!page) return; // 404 keeps Starlight's defaults
  route.sidebar = sidebarFor(page);
  // prev/next stay inside the current docset
  const links: any[] = [];
  const flatten = (es: any[]) => es.forEach((e) => (e.type === 'link' ? links.push(e) : flatten(e.entries)));
  flatten(route.sidebar);
  const i = links.findIndex((l) => l.isCurrent);
  route.pagination = i < 0 ? { prev: undefined, next: undefined } : { prev: links[i - 1], next: links[i + 1] };
  (context.locals as any).osVersion = {
    topics: topicsFor(page),
    picker: pickerFor(page),
    docsets: docsetsFor(page),
  };
});
