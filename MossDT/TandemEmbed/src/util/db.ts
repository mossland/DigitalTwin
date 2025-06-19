import Dexie from 'dexie';

export const db = new Dexie('dt');
db.version(1).stores({
  friends: '++id, name, age' // Primary key and indexed props
});