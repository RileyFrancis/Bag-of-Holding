#!/usr/bin/env python3
"""Checks data/items.csv and data/magic-items.json against each other.

    python3 tools/validate-items.py

Mirrors what items.js does at load — slug ids, appliesTo matching, nameFormat
filling — so a typo in the data shows up here instead of as an item quietly
missing from the Browse list. Exits non-zero on any error; warnings don't fail.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RARITIES = {'common', 'uncommon', 'rare', 'very_rare', 'legendary', 'artifact', 'special'}
TYPES = {'Armor', 'Weapon', 'Wondrous Item', 'Potion', 'Ring', 'Rod', 'Scroll', 'Staff', 'Wand'}
MATCH_WORDS = {'weapon', 'melee', 'ranged', 'simple', 'martial', 'ammunition',
               'armor', 'light', 'medium', 'heavy', 'shield', 'sword', 'axe'}
FIELDS = {'id', 'name', 'type', 'typeNote', 'rarity', 'attunement', 'attunementNote',
          'consumable', 'srd', 'source', 'tags', 'appliesTo', 'nameFormat', 'shape',
          'stackSize', 'damage', 'damageType', 'properties', 'container',
          'containerRows', 'containerCols', 'variants', 'description', 'cost'}
VARIANT_FIELDS = {'id', 'label', 'rarity', 'attunement', 'note', 'cost'}

errors, warnings = [], []


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', re.sub(r"['’]", '', name.lower())).strip('-')


def tag_words(tags):
    return {w for tag in tags for w in tag.lower().split()}


def load_bases():
    with open(ROOT / 'data/items.csv', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['name']]
    bases = {}
    for r in rows:
        bid = slug(r['name'])
        if bid in bases:
            errors.append(f'items.csv: two rows slug to "{bid}"')
        bases[bid] = {'name': r['name'], 'tags': r['tags'].split('|') if r['tags'] else []}
    return bases


def matches(base_id, base, applies):
    if base_id in applies.get('except', []):
        return False
    if base_id in applies.get('bases', []):
        return True
    words = tag_words(base['tags'])
    return any(all(w in words for w in clause) for clause in applies.get('any', []))


def check_shape(where, shape):
    rows = shape.split('|')
    if not all(re.fullmatch(r'[01]+', r) for r in rows):
        errors.append(f'{where}: shape "{shape}" is not 0/1 rows')
    elif '1' not in shape:
        errors.append(f'{where}: shape "{shape}" has no filled cell')


def fill(fmt, base=None, variant=None):
    out = fmt
    if base is not None:
        out = out.replace('{base}', base)
    if variant is not None:
        out = out.replace('{variant}', variant)
    return out


def main():
    bases = load_bases()
    doc = json.loads((ROOT / 'data/magic-items.json').read_text())
    items = doc['items']
    ids, names = {}, {}

    def claim(tid, name, where):
        if tid in ids or tid in bases:
            errors.append(f'{where}: id "{tid}" is already taken')
        ids[tid] = where
        if name is None:  # a family header — never placed, sold or saved
            return
        if name in names:
            errors.append(f'{where}: name "{name}" also made by {names[name]}')
        names[name] = where

    for b in bases.values():
        names[b['name']] = 'items.csv'

    for m in items:
        where = m.get('id', '?')
        for k in m:
            if k not in FIELDS:
                errors.append(f'{where}: unknown field "{k}"')
        for k in ('id', 'name', 'type', 'rarity', 'description', 'tags'):
            if k not in m:
                errors.append(f'{where}: missing "{k}"')
        if m.get('id') != slug(m.get('name', '')):
            warnings.append(f'{where}: id is not the slug of "{m.get("name")}"')
        if m.get('rarity') not in RARITIES:
            errors.append(f'{where}: rarity "{m.get("rarity")}"')
        if m.get('type') not in TYPES:
            errors.append(f'{where}: type "{m.get("type")}"')

        variants = m.get('variants', [])
        vids = set()
        for v in variants:
            for k in v:
                if k not in VARIANT_FIELDS:
                    errors.append(f'{where}~{v.get("id")}: unknown variant field "{k}"')
            if not v.get('id') or not v.get('label'):
                errors.append(f'{where}: variant missing id/label')
            if not re.fullmatch(r'[a-z0-9-]+', v.get('id', '')):
                errors.append(f'{where}: variant id "{v.get("id")}" is not a slug')
            if v.get('id') in vids:
                errors.append(f'{where}: duplicate variant id "{v.get("id")}"')
            vids.add(v.get('id'))
            if 'rarity' in v and v['rarity'] not in RARITIES:
                errors.append(f'{where}~{v["id"]}: rarity "{v["rarity"]}"')

        applies = m.get('appliesTo')
        fmt = m.get('nameFormat')
        if (applies or variants) and not fmt:
            errors.append(f'{where}: needs a nameFormat')

        if applies:
            for k in applies:
                if k not in ('any', 'bases', 'except'):
                    errors.append(f'{where}: unknown appliesTo key "{k}"')
            for clause in applies.get('any', []):
                for w in clause:
                    if w not in MATCH_WORDS:
                        errors.append(f'{where}: appliesTo word "{w}" is not in the vocabulary')
            for bid in applies.get('bases', []) + applies.get('except', []):
                if bid not in bases:
                    errors.append(f'{where}: appliesTo names unknown base "{bid}"')
            for k in ('shape', 'stackSize', 'damage', 'damageType', 'properties'):
                if k in m:
                    warnings.append(f'{where}: overlay sets "{k}" (it is inherited from the base)')
            matched = [bid for bid, b in bases.items() if matches(bid, b, applies)]
            if not matched:
                errors.append(f'{where}: appliesTo matches no base item')
            if len(matched) > 1 and '{base}' not in fmt:
                errors.append(f'{where}: {len(matched)} bases but nameFormat has no {{base}}')
            if variants and '{variant}' not in fmt:
                errors.append(f'{where}: variants but nameFormat has no {{variant}}')
            # A level with one option collapses (see materializeMagicItems in
            # items.js): one base and no variants is a single item under the
            # magic item's own id; one base with variants drops the "@base".
            claim(m['id'], None if (variants or len(matched) > 1) else fill(fmt, bases[matched[0]]['name']), where)
            for v in variants or [None]:
                head = f'{m["id"]}~{v["id"]}' if v else m['id']
                if v and len(matched) == 1:
                    claim(head, fill(fmt, bases[matched[0]]['name'], v['label']), where)
                    continue
                if v:
                    claim(head, None, where)
                if len(matched) == 1:
                    continue
                for bid in matched:
                    claim(f'{head}@{bid}', fill(fmt, bases[bid]['name'], v and v['label']), where)
        else:
            if 'shape' not in m:
                errors.append(f'{where}: standalone item has no shape')
            else:
                check_shape(where, m['shape'])
            claim(m['id'], None if variants else m['name'], where)
            if variants and '{variant}' not in fmt:
                errors.append(f'{where}: variants but nameFormat has no {{variant}}')
            for v in variants:
                claim(f'{m["id"]}~{v["id"]}', fill(fmt, None, v['label']), where)

    for w in warnings:
        print('warning:', w)
    for e in errors:
        print('error:', e)
    print(f'{len(items)} magic items, {len(ids)} templates generated, '
          f'{len(errors)} errors, {len(warnings)} warnings')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
