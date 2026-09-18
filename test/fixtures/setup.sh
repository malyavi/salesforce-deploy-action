#!/usr/bin/env bash
# Builds a throwaway Salesforce DX repository with three branches, so the action
# can be run against it exactly as a caller would — no org involved:
#
#   base    one Apex class
#   docs    a README change and nothing else, so the delta is empty
#   change  an edit to the class, so the delta holds one component
#
# The empty-delta branch is the interesting one: the action has to notice there
# is nothing to deploy and finish green *without* authenticating, which is what
# makes it cheap to run on every push.
#
# Usage: test/fixtures/setup.sh <directory>
set -euo pipefail

target="${1:?Pass the directory to build the fixture repository in}"

rm -rf "$target"
mkdir -p "$target/force-app/main/default/classes"
cd "$target"

git init --quiet --initial-branch=base
git config user.email "smoke@example.com"
git config user.name "Smoke Test"

cat > sfdx-project.json <<'JSON'
{
  "packageDirectories": [
    {
      "path": "force-app",
      "default": true
    }
  ],
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0"
}
JSON

cat > force-app/main/default/classes/Smoke.cls <<'APEX'
public with sharing class Smoke {
    public static Integer one() {
        return 1;
    }
}
APEX

cat > force-app/main/default/classes/Smoke.cls-meta.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <status>Active</status>
</ApexClass>
XML

echo "# Fixture" > README.md
git add -A
git commit --quiet -m "One Apex class"

git checkout --quiet -b docs
printf '\nNothing here is metadata.\n' >> README.md
git add -A
git commit --quiet -m "A documentation change alone"

git checkout --quiet base
git checkout --quiet -b change
cat > force-app/main/default/classes/Smoke.cls <<'APEX'
public with sharing class Smoke {
    public static Integer one() {
        return 2;
    }
}
APEX
git add -A
git commit --quiet -m "Edit the class"

git checkout --quiet base
echo "Fixture repository ready in $target (branches: base, docs, change)"
