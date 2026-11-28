// The File: a new design is named "My design", "My design 2", ... until it has a name of its own.
import { copyName, isAutoName, nextHandName } from '../src/shared/scope';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};

ok('the first is "My design"', nextHandName([]) === 'My design' && nextHandName(['Cosy autumn']) === 'My design');
ok('then "My design 2", "My design 3"', nextHandName(['My design']) === 'My design 2' && nextHandName(['My design', 'My design 2']) === 'My design 3');
ok('a freed number is used again', nextHandName(['My design', 'My design 3']) === 'My design 2');
ok('a renamed one frees its name; case and spaces do not matter', nextHandName(['Renamed', 'my design ']) === 'My design 2' && nextHandName(['Renamed']) === 'My design');
ok('automatic names are told apart from chosen ones', isAutoName('My design') && isAutoName('My design 12') && isAutoName('My edits 2') && !isAutoName('Bamboo garden') && !isAutoName('My design ideas'));
ok('a copy is the name with the next free number', copyName('Bamboo', ['Bamboo']) === 'Bamboo 2' && copyName('Bamboo', ['Bamboo', 'Bamboo 2']) === 'Bamboo 3' && copyName('Bamboo 2', ['Bamboo', 'Bamboo 2']) === 'Bamboo 3');
const long = 'x'.repeat(60);
ok('a 60-character name keeps its number (the name is shortened)', copyName(long, [long]).endsWith(' 2') && copyName(long, [long]).length <= 60 && copyName(long, [long, copyName(long, [long])]).endsWith(' 3'));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
