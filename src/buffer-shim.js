// web3.js uses the Node `Buffer` global in places; browsers do not have one.
// Imported first so it is in place before web3.js evaluates.
import { Buffer } from 'buffer';

globalThis.Buffer ||= Buffer;
