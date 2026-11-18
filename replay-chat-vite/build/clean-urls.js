/**
 * Clean URLs for the multi-page app: /account instead of /account.html. The chat page is the home page, so /index.html is /.
 * `cleanUrl` decides what to do with a request path; the Vite plugin applies it to the dev and preview servers. (A deployed
 * dist/ needs the same rule from its host: nginx `try_files $uri $uri.html =404;`, or "cleanUrls" on Vercel / Netlify.)
 */
export const PAGES = ['replay', 'agents', 'account', 'login'];

/**
 * @param {string} url a request URL (path and optional query)
 * @returns {{redirect: string} | {rewrite: string} | null}
 *   redirect: the old `/page.html` address, sent to its clean one (query kept);
 *   rewrite: a clean address, served from its .html file without changing the address bar;
 *   null: not a page request.
 */
export function cleanUrl(url) {
  const at = url.search(/[?#]/);
  const path = at === -1 ? url : url.slice(0, at);
  const rest = at === -1 ? '' : url.slice(at);
  if (path === '/index.html') return { redirect: '/' + rest };
  const page = path.match(/^\/([a-z]+)(\.html)?\/?$/)?.[1];
  if (!page || !PAGES.includes(page)) return null;
  if (path.endsWith('.html')) return { redirect: `/${page}${rest}` };
  return { rewrite: `/${page}.html${rest}` };
}

function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const result = cleanUrl(req.url ?? '');
  if (!result) return next();
  if (result.redirect) {
    res.statusCode = 301;
    res.setHeader('Location', result.redirect);
    return res.end();
  }
  req.url = result.rewrite;
  next();
}

/** @returns {import('vite').Plugin} */
export const cleanUrlsPlugin = () => ({
  name: 'clean-urls',
  configureServer: (server) => void server.middlewares.use(middleware),
  configurePreviewServer: (server) => void server.middlewares.use(middleware),
});
