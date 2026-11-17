declare const __WW_SITE_URL__: string;

/** The community website this build talks to. Set at build time with WHIMSYWEB_SITE_URL (see build.mjs). */
export const SITE_URL: string = typeof __WW_SITE_URL__ === 'string' ? __WW_SITE_URL__ : 'http://localhost:3000';
