import { customAlphabet } from 'nanoid'

// URL/file-safe, lowercase. Short enough to read, long enough to not collide.
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
const gen = customAlphabet(alphabet, 12)

export const newId = (): string => gen()
