#!/bin/bash
# Rebranding script: CodeNomad → ReactorPro, NeuralNomads → Hyperspace
# Run this after syncing from upstream to apply branding changes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== ReactorPro Rebranding Script ==="
echo "Project root: $PROJECT_ROOT"

# Files/directories to exclude from rebranding
EXCLUDE_PATTERNS=(
    ".git"
    "node_modules"
    ".next"
    "dist"
    "build"
    "target"
    "*.lock"
    "package-lock.json"
    "scripts/rebrand.sh"
)

# Build find exclude arguments
EXCLUDE_ARGS=""
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
    EXCLUDE_ARGS="$EXCLUDE_ARGS -not -path '*/$pattern/*' -not -name '$pattern'"
done

# Function to perform replacements in a file
rebrand_file() {
    local file="$1"
    
    # Skip binary files
    if file "$file" | grep -q "binary"; then
        return 0
    fi
    
    # Create temp file for modifications
    local temp_file=$(mktemp)
    
    # Perform all replacements
    sed -e 's/CodeNomad/ReactorPro/g' \
        -e 's/codenomad/reactorpro/g' \
        -e 's/code-nomad/reactor-pro/g' \
        -e 's/code_nomad/reactor_pro/g' \
        -e 's/NeuralNomads/Hyperspace/g' \
        -e 's/neuralnomads/hyperspace/g' \
        -e 's/neural-nomads/hyperspace/g' \
        -e 's/neural_nomads/hyperspace/g' \
        -e 's/NeuralNomadsAI/Hyperspace/g' \
        -e 's/@neuralnomads\//@hyperspace\//g' \
        -e 's/@NeuralNomads\//@Hyperspace\//g' \
        "$file" > "$temp_file"
    
    # Only update if changes were made
    if ! cmp -s "$file" "$temp_file"; then
        mv "$temp_file" "$file"
        echo "  Rebranded: $file"
        return 1  # Return 1 to indicate changes were made
    else
        rm "$temp_file"
        return 0
    fi
}

export -f rebrand_file

echo ""
echo "Scanning files for rebranding..."

# Find all text files and apply rebranding
CHANGED_COUNT=0
while IFS= read -r -d '' file; do
    if rebrand_file "$file"; then
        : # No changes
    else
        ((CHANGED_COUNT++)) || true
    fi
done < <(find "$PROJECT_ROOT" -type f \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/dist/*" \
    -not -path "*/build/*" \
    -not -path "*/target/*" \
    -not -path "*/.next/*" \
    -not -name "*.lock" \
    -not -name "package-lock.json" \
    -not -name "rebrand.sh" \
    -not -name "*.png" \
    -not -name "*.jpg" \
    -not -name "*.jpeg" \
    -not -name "*.gif" \
    -not -name "*.ico" \
    -not -name "*.icns" \
    -not -name "*.woff" \
    -not -name "*.woff2" \
    -not -name "*.ttf" \
    -not -name "*.eot" \
    -print0)

echo ""
echo "=== Rebranding Complete ==="
echo "Files modified: $CHANGED_COUNT"

# Special handling for package names in package.json files
echo ""
echo "Updating package.json scopes..."

find "$PROJECT_ROOT" -name "package.json" -not -path "*/node_modules/*" | while read -r pkg; do
    if grep -q "@neuralnomads\|NeuralNomads\|CodeNomad" "$pkg" 2>/dev/null; then
        sed -i.bak \
            -e 's/@neuralnomads\//@hyperspace\//g' \
            -e 's/NeuralNomads/Hyperspace/g' \
            -e 's/neuralnomads/hyperspace/g' \
            -e 's/CodeNomad/ReactorPro/g' \
            -e 's/codenomad/reactorpro/g' \
            "$pkg"
        rm -f "${pkg}.bak"
        echo "  Updated: $pkg"
    fi
done

# Rename image files
echo ""
echo "Renaming image files..."
if [ -f "$PROJECT_ROOT/images/CodeNomad-Icon.png" ]; then
    mv "$PROJECT_ROOT/images/CodeNomad-Icon.png" "$PROJECT_ROOT/images/ReactorPro-Icon.png"
    echo "  Renamed: CodeNomad-Icon.png → ReactorPro-Icon.png"
fi
if [ -f "$PROJECT_ROOT/images/CodeNomad-Icon-original.png" ]; then
    mv "$PROJECT_ROOT/images/CodeNomad-Icon-original.png" "$PROJECT_ROOT/images/ReactorPro-Icon-original.png"
    echo "  Renamed: CodeNomad-Icon-original.png → ReactorPro-Icon-original.png"
fi

echo ""
echo "Rebranding complete!"
