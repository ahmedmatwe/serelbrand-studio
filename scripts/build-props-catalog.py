"""Asset collector: rebuilds config/props.json from Microsoft Fluent Emoji 3D (MIT) + Google Noto Emoji Animation
(CC BY 4.0), with the modesty / suitability filter. New objects appear automatically; removed ones disappear.
Run: python3 scripts/build-props-catalog.py   (needs network; GitHub workflow "studio-rnd")."""
import json, re, urllib.request
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'studio-rnd', 'Accept': 'application/vnd.github+json'}), timeout=60) as r:
        return json.loads(r.read())
BAD = re.compile(r'bikini|swimsuit|kiss|couple|wine|beer|cocktail|tropical drink|popping cork|tumbler|sake|cigarette|pig|boar|bacon|middle finger|lipstick|bra\b|thong|nazar|moai|coffin|skull|ghost|alien|devil|ogre|goblin|cross\b|latin cross|orthodox|menorah|om\b|yin|wheel of dharma|star of david|khanda|place of worship|church|shinto|synagogue|hindu|dotted six|aquarius|aries|cancer|capricorn|gemini|leo|libra|pisces|sagittarius|scorpio|taurus|virgo|ophiuchus|crystal ball|joker|flower playing|mahjong|slot|game die|syringe|pill|drop of blood|knife|dagger|bomb|pistol|water pistol|crossed swords|hammer and pick|poo|pile of|vomit|zany|drooling|smirk|pleading|hot face')
tree = get('https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1')['tree']
paths = [t['path'] for t in tree if re.search(r'/3D/[^/]+_3d\.png$', t['path'])]
props = {p.split('/')[1].lower(): p for p in paths if not BAD.search(p.split('/')[1].lower())}
noto = get('https://googlefonts.github.io/noto-emoji-animation/data/api.json')['icons']
tag2cp = {}
for i in noto:
    for t in i['tags']:
        if not BAD.search(t): tag2cp.setdefault(t.strip(':').replace('-', ' ').lower(), i['codepoint'])
animated = {n: tag2cp[n.replace('-', ' ')] for n in props if n.replace('-', ' ') in tag2cp}
old = json.load(open('config/props.json'))
out = {**old, 'props': props, 'animated': animated}
json.dump(out, open('config/props.json', 'w'), ensure_ascii=False)
print(f"objects {len(old['props'])} → {len(props)}, animated {len(old.get('animated', {}))} → {len(animated)}")
