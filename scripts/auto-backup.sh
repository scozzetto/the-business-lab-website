#!/bin/bash

# Business Lab Auto-Backup System
# Runs every 30 minutes to backup everything to Dropbox

TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
PROJECT_DIR="/Users/silviomac/Library/CloudStorage/Dropbox/WEBSITES_SECURE_BACKUP/business-lab-website/main-working"
BACKUP_BASE="/Users/silviomac/Library/CloudStorage/Dropbox/WEBSITES_SECURE_BACKUP/business-lab-website/backups"
BACKUP_DIR="$BACKUP_BASE/auto-backup-$TIMESTAMP"
LATEST_LINK="$BACKUP_BASE/latest-backup"

echo "🔄 Starting Business Lab auto-backup at $TIMESTAMP"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Copy entire project (excluding large/unnecessary files)
echo "📁 Copying Business Lab project files..."
rsync -av --progress \
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
  "$PROJECT_DIR/" "$BACKUP_DIR/business-lab-website/"

# Create git status backup
cd "$PROJECT_DIR"
echo "🔍 Capturing git status..."
git status > "$BACKUP_DIR/git-status.txt" 2>&1
git log --oneline -10 > "$BACKUP_DIR/git-recent-commits.txt" 2>&1
git diff > "$BACKUP_DIR/git-uncommitted-changes.txt" 2>&1

# Create system info
echo "💻 Capturing system info..."
echo "Backup created: $TIMESTAMP" > "$BACKUP_DIR/backup-info.txt"
echo "PWD: $(pwd)" >> "$BACKUP_DIR/backup-info.txt"
echo "Git branch: $(git branch --show-current 2>/dev/null || echo 'unknown')" >> "$BACKUP_DIR/backup-info.txt"
echo "Last modified files:" >> "$BACKUP_DIR/backup-info.txt"
find . -type f -name "*.html" -o -name "*.js" -o -name "*.css" -exec ls -la {} \; | head -20 >> "$BACKUP_DIR/backup-info.txt"

# Update latest link
rm -f "$LATEST_LINK"
ln -s "$BACKUP_DIR" "$LATEST_LINK"

# Keep only last 20 backups (cleanup old ones)
cd "$BACKUP_BASE"
ls -dt auto-backup-* | tail -n +21 | xargs rm -rf

# Report backup size and file count
BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
FILE_COUNT=$(find "$BACKUP_DIR" -type f | wc -l | xargs)

echo "✅ Business Lab backup complete: $BACKUP_DIR"
echo "📊 Backup size: $BACKUP_SIZE with $FILE_COUNT files"
echo "🔗 Latest backup link updated"

# Log to central backup log
echo "$TIMESTAMP - Business Lab backup completed successfully" >> "$BACKUP_BASE/backup.log"