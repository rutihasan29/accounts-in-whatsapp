const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Using ffmpeg at:', ffmpeg.path);

execFileSync(ffmpeg.path, ['-y', '-i', 'voice1.wav', '-b:a', '128k', 'voice1.mp3']);
console.log('voice1.mp3 created, size:', fs.statSync('voice1.mp3').size);

execFileSync(ffmpeg.path, ['-y', '-i', 'voice2.wav', '-b:a', '128k', 'voice2.mp3']);
console.log('voice2.mp3 created, size:', fs.statSync('voice2.mp3').size);
