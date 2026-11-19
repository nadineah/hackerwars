// The open chat must survive moments when the active tab's address is briefly unknown.
import { keepChat } from '../src/sidepanel/keepChat';

let fails = 0;
const ok = (name: string, cond: boolean) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
};
const chat = { host: 'wayne.edu', scope: 'site' };
ok('same site: stays open', keepChat(chat, 'wayne.edu'));
ok('address briefly unknown (loading page): stays open', keepChat(chat, null));
ok('the chat is not in the list yet: stays open', keepChat(undefined, 'wayne.edu'));
ok('a different known site: closes', !keepChat(chat, 'meetup.com'));
ok('an all-sites chat follows you to any site', keepChat({ host: 'wayne.edu', scope: 'global' }, 'meetup.com'));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
