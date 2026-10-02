function calculateBill(durationInSeconds) {
    if (!durationInSeconds || durationInSeconds <= 0) return 0;

    const roundedSeconds = Math.round(durationInSeconds);

    if (roundedSeconds <= 68) { // 0:00 to 1:08
        return 50;
    }
    if (roundedSeconds <= 79) { // 1:09 to 1:19
        return 75;
    }

    const offset = roundedSeconds - 80; // starting at 1:20 (80s)
    const k = Math.floor(offset / 60);
    const remainder = offset % 60;

    if (remainder <= 48) { // x:20 to (x+1):08
        return 100 + (k * 50);
    } else { // (x+1):09 to (x+1):19
        return 125 + (k * 50);
    }
}

function formatDuration(durationInSeconds) {
    const totalSec = Math.round(durationInSeconds || 0);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

module.exports = {
    calculateBill,
    formatDuration
};
