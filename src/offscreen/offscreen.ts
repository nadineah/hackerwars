import { runParse, type ParseRequest } from '../dashboard/collect';

/**
 * Offscreen document: a place with a DOM where the worker can have downloaded text parsed. DOMParser documents are
 * inert: no scripts run, no images or stylesheets load, no network requests are made.
 */
chrome.runtime.onMessage.addListener((msg: { target?: string; req?: ParseRequest }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'ww-offscreen' || !msg.req) return;
  sendResponse(runParse(msg.req, (text, type) => new DOMParser().parseFromString(text, type)));
});
