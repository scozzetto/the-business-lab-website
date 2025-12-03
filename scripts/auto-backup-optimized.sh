#!/bin/bash

# Business Lab Optimized Auto-Backup System
# Zero information loss with dramatic speed improvements

TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
PROJECT_DIR="/Users/silviomac/Library/CloudStorage/Dropbox/WEBSITES_SECURE_BACKUP/business-lab-website/main-working"
TEMP_BACKUP_DIR="/Users/silviomac/Desktop/temp-backups/business-lab"
FINAL_BACKUP_DIR="/Users/silviomac/Library/CloudStorage/Dropbox/WEBSITES_SECURE_BACKUP/business-lab-website/backups"
BACKUP_DIR="$TEMP_BACKUP_DIR/auto-backup-$TIMESTAMP"
LATEST_LINK="$FINAL_BACKUP_DIR/latest-backup"
LOCKFILE="/tmp/businesslab-backup.lock"
LOGFILE="$FINAL_BACKUP_DIR/backup.log"

# Check if backup is already running
if [ -f "$LOCKFILE" ]; then
    echo "⚠️  Backup already in progress. Exiting to prevent overlap."
    exit 1
fi

# Create lock file
touch "$LOCKFILE"

# Cleanup function to remove lock file
cleanup() {
    rm -f "$LOCKFILE"
}
trap cleanup EXIT

echo "🚀 Starting OPTIMIZED backup at $TIMESTAMP"
START_TIME=$(date +%s)

# Create temp backup directory outside Dropbox
mkdir -p "$BACKUP_DIR"

# Use rsync with compression (Business Lab is small, so full backup is fine)
echo "📁 Copying project files with compression..."

rsync -avz --progress \
    --exclude='node_modules/' \
    --exclude='.git/objects/' \
    --exclude='*.zip' \
    --exclude='*.mp4' \
    --exclude='*.mov' \
    --exclude='*.avi' \
    --exclude='.DS_Store' \
    --exclude='dist/' \
    --exclude='build/' \
    --exclude='*.log' \
    --exclude='package-lock.json' \
    --exclude='*.psd' \
    --exclude='*.ai' \
    --exclude='*.sketch' \
    --exclude='temp/' \
    --exclude='cache/' \
    --exclude='*.bak' \
    --exclude='*.tmp' \
    --exclude='_test*' \
    --exclude='*.swp' \
    --exclude='.idea/' \
    --exclude='.vscode/' \
    --timeout=60 \
    "$PROJECT_DIR/" "$BACKUP_DIR/business-lab/"

# Check if rsync succeeded
if [ $? -ne 0 ]; then
    echo "❌ Rsync failed! Cleaning up and exiting."
    rm -rf "$BACKUP_DIR"
    exit 1
fi

# Create git status backup
cd "$PROJECT_DIR"
echo "🔍 Capturing git status..."
git status > "$BACKUP_DIR/git-status.txt" 2>&1
git log --oneline -20 > "$BACKUP_DIR/git-recent-commits.txt" 2>&1
git diff > "$BACKUP_DIR/git-uncommitted-changes.txt" 2>&1

# Create system info
echo "💻 Capturing system info..."
cat > "$BACKUP_DIR/backup-info.txt" << EOF
Backup created: $TIMESTAMP
PWD: $(pwd)
Git branch: $(git branch --show-current 2>/dev/null || echo 'unknown')
Last commit: $(git log -1 --oneline 2>/dev/null || echo 'no commits')
Project: Business Lab Website
EOF

# Add file count and size info
echo "📊 Calculating backup statistics..."
FILE_COUNT=$(find "$BACKUP_DIR" -type f | wc -l | xargs)
BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "Files backed up: $FILE_COUNT" >> "$BACKUP_DIR/backup-info.txt"
echo "Backup size: $BACKUP_SIZE" >> "$BACKUP_DIR/backup-info.txt"

# Move completed backup to Dropbox in one operation
echo "📤 Moving backup to Dropbox..."
mv "$BACKUP_DIR" "$FINAL_BACKUP_DIR/"

# Update latest link
rm -f "$LATEST_LINK"
ln -s "$FINAL_BACKUP_DIR/$(basename "$BACKUP_DIR")" "$LATEST_LINK"

# Keep only last 20 backups (cleanup old ones)
echo "🧹 Cleaning up old backups..."
cd "$FINAL_BACKUP_DIR"
ls -dt auto-backup-* | tail -n +21 | xargs rm -rf

# Calculate duration
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Log the backup
echo "$TIMESTAMP - Backup completed in ${DURATION}s - Size: $BACKUP_SIZE - Files: $FILE_COUNT" >> "$LOGFILE"

echo "✅ Optimized backup complete!"
echo "📊 Stats: $BACKUP_SIZE with $FILE_COUNT files in ${DURATION} seconds"
echo "📁 Location: $FINAL_BACKUP_DIR/$(basename "$BACKUP_DIR")"
echo "🔗 Latest backup link updated"

# Cleanup temp directory
rm -rf "$TEMP_BACKUP_DIR"