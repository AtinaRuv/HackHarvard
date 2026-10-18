#!/usr/bin/env node
import {main} from './test-browser.js';
await main('final').catch(error=>{console.error(error.message);process.exitCode=1});
