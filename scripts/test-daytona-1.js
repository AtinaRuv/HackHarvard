#!/usr/bin/env node
import {main} from './test-browser.js';
await main('initial').catch(error=>{console.error(error.message);process.exitCode=1});
