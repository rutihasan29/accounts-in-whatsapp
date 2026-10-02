const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'bills.json');

function readDb(filePath = DEFAULT_FILE) {
    try {
        if (!fs.existsSync(filePath)) {
            return {};
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data || '{}');
    } catch (err) {
        console.error('Error reading bills DB:', err);
        return {};
    }
}

function writeDb(data, filePath = DEFAULT_FILE) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing bills DB:', err);
    }
}

function getCustomerBill(phoneNumber, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    return db[phoneNumber] || { totalBill: 0, transactions: [] };
}

function recordTransaction(phoneNumber, transaction, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    if (!db[phoneNumber]) {
        db[phoneNumber] = { totalBill: 0, transactions: [] };
    }

    db[phoneNumber].transactions.push({
        timestamp: new Date().toISOString(),
        ...transaction
    });
    db[phoneNumber].totalBill += transaction.amount;

    writeDb(db, filePath);
    return db[phoneNumber];
}

function clearCustomerBill(phoneNumber, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    if (db[phoneNumber]) {
        db[phoneNumber].totalBill = 0;
        db[phoneNumber].transactions = [];
        writeDb(db, filePath);
    }
    return { totalBill: 0, transactions: [] };
}

module.exports = {
    getCustomerBill,
    recordTransaction,
    clearCustomerBill
};
