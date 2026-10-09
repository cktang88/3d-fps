# Asset sources — vetted catalogue for Ironline

> **Historical shopping list (asset-scout pass, 2026-10-08).** It is not the list of shipped assets: the README
> "Credits & licences" section is authoritative for what is in `public/assets/`. Statements such as "already used"
> or "the current arms" describe the game on that date.

Curated against `docs/QUALITY_BAR.md` (stormy golden hour after rain, photoreal PBR, cohesive fidelity) and
`docs/ART_PIPELINE.md` (everything goes through gltf-transform plus the unify pass). Every entry was checked for
licence, and previews were viewed.

**Adopted from this list** (as of 2026-10-09): the ccransh rigs (AK-74m, pistol, sniper rifle, Remington 870) as arm
rig and grip templates; the Generic Red Dot by valterjherson1; the 1799danly "Military tactical suit
(LowPolyGameReady)" for the bots; Quaternius UAL 1 & 2; the Unity Labs flipbooks (Explosion01, WispySmoke02, Flame03);
ambientCG Leaking, GraffitiSet001, Tape001, TireTracks001 and AsphaltDamage decals; the Free Firearm Sound Library;
Kenney Interface Sounds. Everything else here was **evaluated, not used**. Several shipped assets came from outside
this list: the gloved arms ("Fps arms" by bumstrum, 9452ce4c, not the e3c42c05 arms below), most FP guns and the
other optics (see `docs/FP_FRAMING.md` §7), the alexdelker burnt car and helijah UH-60, the BAMEN rig, 100STYLE
mocap, and the Free FPS Template animations (Fab licence; see the note in §9).

**Legend**
- ★ = **recommended** (top pick for that slot).
- **Fit** = style fit 1–5 (5 means it sits next to Poly Haven/ambientCG scans without a seam).
- **Faces** = Sketchfab `faceCount` (≈ triangles) of the whole scene, including arms and props in FPS rigs.
- **Size** = archive size reported by the source API (Sketchfab: `glb` / `gltf` download; Poly Haven: 1k glTF + maps).
- Licence quotes are the exact label returned by the source's API or page. Sketchfab "CC Attribution" = CC BY 4.0.

**Licence rules applied**: only CC0, CC‑BY, CC‑BY‑SA, MIT/Apache/BSD where the licence explicitly covers the art. NC, ND,
editorial, store licences, ripped game assets, Mixamo content and AI-generated meshes with unclear rights are all
excluded (see [§9 Rejected](#9-rejected--do-not-use)).
**CC‑BY obligations**: credit author, link source and licence, state modifications, all in the README credits block.
**Trademarks**: several realistic guns carry real maker logos (Colt, H&K, EOTech, Remington). CC‑BY covers copyright,
not trademarks, so blank or retexture the roll-marks during the bake. jeandiz's AR‑15 already uses fictional logos.

---

## 0. Download helpers (keep tokens out of the repo)

```bash
# Sketchfab (CC-BY models). Token lives OUTSIDE the repo, e.g. in a scratchpad file; never commit it.
export SKETCHFAB_TOKEN="$(cat /path/outside/repo/.sketchfab_token)"
sf_glb() {   # usage: sf_glb <uid> <out.glb>   (signed URL expires after ~5 min)
  curl -s -H "Authorization: Token $SKETCHFAB_TOKEN" "https://api.sketchfab.com/v3/models/$1/download" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["glb"]["url"])' | xargs curl -L -o "$2"
}
# Poly Haven 1k glTF (+ textures). Usage: ph_gltf <asset_id> <outdir>
ph_gltf() {
  mkdir -p "$2"; curl -s "https://api.polyhaven.com/files/$1" | python3 -c '
import json,sys,subprocess,os
g=json.load(sys.stdin)["gltf"]["1k"]["gltf"]; out=sys.argv[1]
subprocess.run(["curl","-sL","-o",os.path.join(out,os.path.basename(g["url"])),g["url"]])
for rel,v in g["include"].items():
    p=os.path.join(out,rel); os.makedirs(os.path.dirname(p),exist_ok=True); subprocess.run(["curl","-sL","-o",p,v["url"]])' "$2"
}
# Poly Haven HDRI: https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/<1k|2k|4k>/<id>_<res>.hdr
# ambientCG:        https://ambientcg.com/get?file=<AssetId>_<1K|2K>-<JPG|PNG>.zip
```
Then run the normal pipeline: `gltf-transform optimize in.glb out.glb --texture-compress webp --texture-size 1024 ...`.

---

## 1. First-person arms & weapons

**Key finding:** DJMaesen (`bumstrum`, CC‑BY) made the game's current arms. **ccransh** built a whole family of
realistic FPS rigs on those same gloved arms (AK‑74M, SMG, sniper, pistol, Makarov, Benelli and Remington shotguns).
Each has 4–9 animation clips (draw, idle, fire, reload, inspect…) and the same visual hands. Adopting them gives one
consistent pair of arms across the arsenal, which is exactly the "cohesive fidelity" bar. They replace the current
low-poly Quaternius/OGA guns, the biggest visual gap in the game today.

### 1a. Animated arms + weapon rigs (glTF with clips)

| ★ | Name / source | Licence (verified) | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **FPS AK‑74m animations** — ccransh · [sketchfab 94be8385…](https://sketchfab.com/3d-models/94be8385c402474cacd39bc096c6ca14) | "CC Attribution". Credits AK‑74M by creationwasteland, arms by DJMaesen | glb 15.1 MB · gltf 96 MB | 40k faces incl. arms; **8 clips**; metal/rough PBR; DJMaesen olive gloves; realistic worn AK | 5 | `sf_glb 94be8385c402474cacd39bc096c6ca14 ak74m_fp.glb` |
| ★ | **SMG FPS Animations** (MPA 30 SST) — ccransh · [ca37ea91…](https://sketchfab.com/3d-models/ca37ea9148dc4fcc9cc632175d311b23) | "CC Attribution". Gun by eNse7en, arms by DJMaesen | glb (≈15 MB) | 29k faces; **8 clips**; PBR; tan finish | 5 | `sf_glb ca37ea9148dc4fcc9cc632175d311b23 smg_fp.glb` |
| ★ | **FPS animations sniper rifle** — ccransh · [c15ae839…](https://sketchfab.com/3d-models/c15ae8393d824f5b929e3f69691cdd31) | "CC Attribution". Rifle by Naches, arms by DJMaesen | glb (≈15 MB) | 35k faces; **6 clips** incl. bolt cycle; wood-stock bolt sniper + scope | 5 | `sf_glb c15ae8393d824f5b929e3f69691cdd31 sniper_fp.glb` |
| ★ | **FPS Benelli M4 Animations** — ccransh · [225a6219…](https://sketchfab.com/3d-models/225a62190f6043ca975eaa2798ab7e2c) | "CC Attribution". M4 Super 90 by haoliu95, gloves by teenjust500 | glb (≈15 MB) | 46k faces; **8 clips** incl. shell loading; different (black) gloves, so re-skin to DJMaesen arms or accept | 4 | `sf_glb 225a62190f6043ca975eaa2798ab7e2c benelli_fp.glb` |
| ★ | **FPS Arms remington (shotgun)** — ccransh · [e68ef617…](https://sketchfab.com/3d-models/e68ef617fe8a48cca8610d016ffd5881) | "CC Attribution". R870 by tris09, arms by DJMaesen | glb 8.4 MB | 9k faces; **4 clips**; **pump** shotgun (fits the pump slot better than Benelli); author notes left-arm lag in glTF, so check the clips | 4 | `sf_glb e68ef617fe8a48cca8610d016ffd5881 r870_fp.glb` |
| ★ | **FPS pistol animations** (Springfield XD) — ccransh · [0d7a343d…](https://sketchfab.com/3d-models/0d7a343dcb6f401197a73c91aee93f6d) | "CC Attribution". XD by raimeiyonke, arms by DJMaesen | glb (≈12 MB) | 33k faces; **5 clips**; specular-gloss PBR (convert to metal/rough) | 4 | `sf_glb 0d7a343dcb6f401197a73c91aee93f6d pistol_fp.glb` |
|   | **Makarov PM FPS animations** — ccransh · [d02ebd58…](https://sketchfab.com/3d-models/d02ebd58e3cf44acb7af73e3f156be28) | "CC Attribution". PM by Bexxie, arms by DJMaesen | glb 12.6 MB | 18k faces; **5 clips**; rig re-fixed by author; good OPFOR sidearm | 4 | `sf_glb d02ebd58e3cf44acb7af73e3f156be28 makarov_fp.glb` |
|   | **Animated FPS hands (rifle animation pack)** — ccransh · [5f2d0ed7…](https://sketchfab.com/3d-models/5f2d0ed780a94724b36ab505f7564057) | "CC Attribution". ACR by doomsentinel, arms by DJMaesen | glb 14.5 MB | 27k faces; **8 clips**; the AR-platform slot; author warns of glitchy vertices in the web viewer | 4 | `sf_glb 5f2d0ed780a94724b36ab505f7564057 acr_fp.glb` |
|   | **FPS animations VSK** — ccransh · [191e34e0…](https://sketchfab.com/3d-models/191e34e043d546718d9e899d19d2f974) | "CC Attribution". VSK‑94 by valterjherson1 | glb 19.1 MB | 28k faces, **7 clips**; **bare hands** (no gloves), so mismatch; use the gun and clips, keep DJMaesen arms | 3 | `sf_glb 191e34e043d546718d9e899d19d2f974 vsk_fp.glb` |
|   | **fps AK animated** / **LMG** / **sniper animated** — DJMaesen (bumstrum) · [b0b1bae4…](https://sketchfab.com/3d-models/b0b1bae40337449189483f6187cf7af7), [8c24d737…](https://sketchfab.com/3d-models/8c24d7374ea64bdab1c30f49c69d5ed8), [eae1ba5b…](https://sketchfab.com/3d-models/eae1ba5b43ae4bc89b0647fb5d8a2d27) | "CC Attribution" (battle rifle 83307e08 is BY‑SA) | glb 8.2 / 5.5 MB | Same author as the current arms; 1 baked clip each; 2k maps; **LMG** (27k f, parts separated for animation) is the only clean LMG with matching style | 4 | `sf_glb 8c24d7374ea64bdab1c30f49c69d5ed8 lmg.glb` |

### 1b. Base arms (for re-skinning / new rigs)

| ★ | Name / source | Licence | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **First Person arms** — DJMaesen · [e3c42c05…](https://sketchfab.com/3d-models/e3c42c05b22944e5839deb8e003f0987) | "CC Attribution" | glb 4.0 MB | 7.2k faces, rigged, 2k maps, fingerless gloves + sleeves; the base every ccransh rig uses | 5 | `sf_glb e3c42c05b22944e5839deb8e003f0987 arms.glb` |
|   | **Hand With Gloves** — teenjust500 · [5a6a434b…](https://sketchfab.com/3d-models/5a6a434b8ec943ffacc581358781eecb) | "CC Attribution" | — | 20k faces; full tactical gloves (used by the Benelli rig) | 4 | `sf_glb 5a6a434b8ec943ffacc581358781eecb gloves.glb` |
|   | **fps arms rigged only** — OpenGameArt · [link](https://opengameart.org/content/fps-arms-rigged-only) | CC0 (`publicdomain/zero/1.0`) | .7z (blend/fbx) | ~8k tris, 1k texture, **bare skin**, no anims; CC0 fallback only | 2 | `curl -LO "https://opengameart.org/sites/default/files/fps%20arms.7z"` |

### 1c. Static weapon models (world models, pickups, bots, or re-rig to the arms)

| ★ | Name / source | Licence | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **AKM Assault Rifle (game ready)** — kennethtzh · [8b6ce774…](https://sketchfab.com/3d-models/8b6ce77441f8446786e0680d61d327db) | "CC Attribution" | glb 23.7 MB | 16.2k tris, **4×2k PBR**, side rail + Aimpoint PRO; very clean UV split; best AK in the set | 5 | `sf_glb 8b6ce77441f8446786e0680d61d327db akm.glb` |
| ★ | **Colt M4A1 Carbine** — haoliu95 · [fa4a73fa…](https://sketchfab.com/3d-models/fa4a73faf4234e5db4066335074a7655) | "CC Attribution" | glb 14.1 MB | 84k faces (simplify for world model), 4k Substance PBR, real roll-marks (blank them) | 5 | `sf_glb fa4a73faf4234e5db4066335074a7655 m4a1.glb` |
| ★ | **AR‑15 style rifle** — jeandiz · [50d33435…](https://sketchfab.com/3d-models/50d33435445e439c95e3b36e9d4bd798) | "CC Attribution" | glb 12.8 MB | 30k faces, reworked UVs; **fictional logos**, so trademark-safe; ACOG-style optic | 5 | `sf_glb 50d33435445e439c95e3b36e9d4bd798 ar15.glb` |
| ★ | **Remington 870 Police Magnum** — haoliu95 · [eea11de7…](https://sketchfab.com/3d-models/eea11de7e9d24b6683962b8388c319eb) | "CC Attribution" | glb 6.4 MB | 17k faces, 4k PBR PNG, OpenGL normals, shells included | 5 | `sf_glb eea11de7e9d24b6683962b8388c319eb r870.glb` |
| ★ | **Remington Model 700 BDL** — haoliu95 · [09c6c23b…](https://sketchfab.com/3d-models/09c6c23bde8547b1880d76d6b95cd481) | "CC Attribution" | glb 9.7 MB | 48k faces, 4k PBR, camo synthetic stock + scope; bolt sniper | 5 | `sf_glb 09c6c23bde8547b1880d76d6b95cd481 r700.glb` |
| ★ | **HK MP5 SMG** — dani-zzz · [fad0226e…](https://sketchfab.com/3d-models/fad0226e1dcf4af180f707a5509d3a4e) | "CC Attribution" | glb 16.5 MB | 32k faces, 16k verts, 4k photoreal PBR | 5 | `sf_glb fad0226e1dcf4af180f707a5509d3a4e mp5.glb` |
|   | **AK 47 Tactical Upgrade** — jeandiz · [b15d69e8…](https://sketchfab.com/3d-models/b15d69e8a5a948819c8c388f97930b9c) | "CC Attribution" | glb 5.1 MB | 18k faces; underfolder AK + suppressor; worn wood; light | 5 | `sf_glb b15d69e8a5a948819c8c388f97930b9c ak_tac.glb` |
|   | **AK74M Assault Rifle** — creationwasteland · [8eea0d04…](https://sketchfab.com/3d-models/8eea0d04d81b4476bb36bf7e6cfc389c) | "CC Attribution" | glb 8.2 MB | 47k faces; the source of the ccransh AK rig (world model that matches the FP model) | 5 | `sf_glb 8eea0d04d81b4476bb36bf7e6cfc389c ak74m.glb` |
|   | **Colt Government 1911 "Pre‑Series 70"** — haoliu95 · [d678acd7…](https://sketchfab.com/3d-models/d678acd79a3e48c7a390922192a3cc2f) | "CC Attribution" | glb 5.9 MB | 40k faces, Substance PBR, separate magazine | 5 | `sf_glb d678acd79a3e48c7a390922192a3cc2f m1911.glb` |
|   | **Heckler & Koch USP** — Urpo · [972e3643…](https://sketchfab.com/3d-models/972e3643000246e8959a6df509557bcc) | "CC Attribution" | glb 5.2 MB | 7.3k faces, baked high-to-low normals, game-ready | 4 | `sf_glb 972e3643000246e8959a6df509557bcc usp.glb` |
|   | **Beretta M9** — ense7en · [34801528…](https://sketchfab.com/3d-models/348015284eca46fe8e1822508381dfd8) | "CC Attribution" | glb 26.8 MB (2k maps) | ~7.7k faces + bullets; tan two-tone; high quality | 4 | `sf_glb 348015284eca46fe8e1822508381dfd8 m9.glb` |
|   | **Bolt Action Rifle 7.62** / **Service Pistol** — Poly Haven · [bolt_action_rifle_7_62](https://polyhaven.com/a/bolt_action_rifle_7_62), [service_pistol](https://polyhaven.com/a/service_pistol) | CC0 (Poly Haven, all assets CC0) | 1k glTF 6.0 / 3.3 MB | 20k / 27k tris; scan-grade PBR; WWII-era Mosin with camo wrap and Walther-style pistol; same shading family as the props | 4 | `ph_gltf bolt_action_rifle_7_62 dl/`; `ph_gltf service_pistol dl/` |

### 1d. Attachments

| ★ | Name / source | Licence | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Eotech 553** — yarogor · [8d119177…](https://sketchfab.com/3d-models/8d1191779e1c4a66a98e122f7551c305) | "CC Attribution" | glb 26.3 MB | 12.5k faces mid-poly; holo sight; real logo, so blank it | 5 | `sf_glb 8d1191779e1c4a66a98e122f7551c305 eotech.glb` |
| ★ | **Silencers Pack 1** — pedrobelthori · [e96a0197…](https://sketchfab.com/3d-models/e96a019757a6440390edfef888f0867e) | "CC Attribution" | glb 20.5 MB | 5 suppressors, 3.2k faces total, 2k PBR; tone down the red accents | 4 | `sf_glb e96a019757a6440390edfef888f0867e silencers.glb` |
|   | **ZENITCO VZOR‑4 red dot** — suspensy · [d1a488b6…](https://sketchfab.com/3d-models/d1a488b627e846ec8378ee426a670441) | "CC Attribution" | glb 26.5 MB | 22k tris for the sight alone (the scene adds charger and cable, so strip them); 2k maps; AK-side optic | 4 | `sf_glb d1a488b627e846ec8378ee426a670441 vzor.glb` |
|   | **10 Lowpoly Muzzle Brakes / Flash Suppressors** — valterjherson1 · [2c11b7ad…](https://sketchfab.com/3d-models/2c11b7ad550448f0bc67284af358e798) | "CC Attribution" | — | 26.6k faces for 10 devices; same author as the VSK | 4 | `sf_glb 2c11b7ad550448f0bc67284af358e798 brakes.glb` |
|   | **Generic Red Dot Scope** — valterjherson1 · [8bf2794c…](https://sketchfab.com/3d-models/8bf2794c30d04fa0aed1e3df92cd8a9e) | "CC Attribution" | — | 5.2k faces, brand-free | 4 | `sf_glb 8bf2794c30d04fa0aed1e3df92cd8a9e reddot.glb` |
|   | **TAC Vertical grip** — artist_dudu · [cf61913a…](https://sketchfab.com/3d-models/cf61913aeb2d422da63ba5d21aa09b1e) | "CC Attribution" | — | 6k faces; only realistic standalone grip found (low-likes, so check textures) | 3 | `sf_glb cf61913aeb2d422da63ba5d21aa09b1e vgrip.glb` |

Magazines come with almost every rig above as a separate mesh (AKM, M1911, MP5, the ccransh rigs). No standalone
magazine pack beat them.

---

## 2. Soldiers (third person, rigged)

| ★ | Name / source | Licence (verified) | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Soldier Full Tactical Gear** — 1799danly · [850593a8…](https://sketchfab.com/3d-models/850593a8c7114c188395ba1849a66eb9) | "CC Attribution"; author: "Free to use for your super projects!" | glb 25.5 MB | 84k faces, metal/rough PBR, plate carrier, helmet, mask; **rigged with 1 clip**. Re-target the CC0 Quaternius UAL clips (already in the game); drop the baked clip if it turns out to be Mixamo | 5 | `sf_glb 850593a8c7114c188395ba1849a66eb9 soldier_tac.glb` |
| ★ | **Military tactical suit (LowPolyGameReady)** — 1799danly · [ef698ce3…](https://sketchfab.com/3d-models/ef698ce36b1545a78ce592dd3db4c7ed) | "CC Attribution"; "A completely free model for anything!" | glb 17.9 MB | 32k faces; game-budget; same author and shading as above, so a cohesive squad (also 342501b0, 23k f) | 5 | `sf_glb ef698ce36b1545a78ce592dd3db4c7ed soldier_lp.glb` |
| ★ | **Microsoft Rocketbox — Military_Male_01…06, Military_Female_01/02** · [github.com/microsoft/Microsoft-Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | **MIT**. `LICENSE.md`: "MIT License — Copyright (c) 2020 Microsoft"; README: "The library of avatars is now released under MIT License." Covers the asset files | FBX (≈0.9 MB) + TGA diffuse/normal/spec; hipoly/midpoly/lowpoly LODs | 8 rigged US-Army ACU soldiers (helmet, vest, knife); 3ds Max Biped skeleton (retarget to UAL); **417 MIT animations** in `Assets/Animations` (locomotion, crouch, idles, no weapon clips). Dated spec workflow, so convert. Diversity and LODs are excellent | 3 | `git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/Microsoft-Rocketbox && cd Microsoft-Rocketbox && git sparse-checkout set Assets/Avatars/Professions/Military_Male_01 Assets/Avatars/Professions/Military_Male_03` |
|   | **S.W.A.T. Operator** / **FSB Operator** — jeandiz · [9e82fabf…](https://sketchfab.com/3d-models/9e82fabf26194896b5ad4a364d864eab), [43a561e9…](https://sketchfab.com/3d-models/43a561e941704eefb1ab0614be4f0049) | "CC Attribution". Built from CC-BY clothing by ErhanMatur, Bzovius, SrGeneroso et al. (credit chain in description) | glb 31.5 / 23.5 MB | 107k / 114k faces, **posed (1 clip)**: hero/cinematic quality, too heavy for bots without simplify; check the rig before committing | 4 | `sf_glb 43a561e941704eefb1ab0614be4f0049 fsb.glb` |
|   | **Polish soldier** — buh-late · [fb96a663…](https://sketchfab.com/3d-models/fb96a663fc4a4246a57ca85de3228c00) | "CC Attribution" | glb 35.1 MB | 123k faces, gas mask, Beryl rifle; a "simplified version" exists (link in description). Also **City Soldier** 636b5a7c (44k f, 1 clip, modular gear) | 4 | `sf_glb 636b5a7c7e0c400abda269ba382f3252 city_soldier.glb` |
|   | **Insurgent (low poly game ready)** — badbih337 · [b0f2d80c…](https://sketchfab.com/3d-models/b0f2d80c7cea42629bdf1ff8e835b4b7) | "CC Attribution" | glb 25.2 MB | 52k faces, 4k textures, rigged (T-pose); OPFOR militia look | 4 | `sf_glb b0f2d80c7cea42629bdf1ff8e835b4b7 insurgent.glb` |
|   | **clothing asset pack** (militia jackets/pants/balaclava) — Marko1937 · [74d6c168…](https://sketchfab.com/3d-models/74d6c1687d764468a9a427732ca664ab) | "CC Attribution" | glb 13.3 MB | 34k faces, 4k, 3 materials; kitbash variety onto any base body | 4 | `sf_glb 74d6c1687d764468a9a427732ca664ab clothing.glb` |
|   | **Universal Animation Library 1 & 2** — Quaternius · [UAL](https://quaternius.com/packs/universalanimationlibrary.html), [OGA UAL2](https://opengameart.org/content/universal-animation-library-2) | CC0 | glTF/FBX | Already used for bots. UAL1 has the gun/combat set; UAL2 adds 130+ clips. Keep as the animation backbone and retarget the meshes above onto it | — | site download |
|   | **CMU Graphics Lab Motion Capture DB** (BVH conversions) · [mocap.cs.cmu.edu](http://mocap.cs.cmu.edu) | Permissive custom terms (paraphrased from the CMU site; re-read before use): free for research, may be included in commercially sold products, may not be resold directly (even converted) | BVH | Thousands of real mocap clips (run, crouch, crawl, some combat). Allowed to ship inside a game, **not as a standalone dataset**. Retarget offline, ship baked clips only | — | `https://mocap.cs.cmu.edu` |

---

## 3. Environment

### 3a. Vehicles, wrecks, aircraft

| ★ | Name / source | Licence | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Burned‑out Cars** — kryik1023 · [701066df…](https://sketchfab.com/3d-models/701066df6b914fd08318524c7ccd96a7) | "CC Attribution". Derived from public-domain footage | glb 11.3 MB | **3.5k faces** for two burnt sedans, PBR; author calls them placeholders, but at depot distance they read photoreal (charred, rust-streaked, glassless) | 5 | `sf_glb 701066df6b914fd08318524c7ccd96a7 burnt_cars.glb` |
| ★ | **Abandoned Soviet BTR‑80** — GameDevNick · [32145d63…](https://sketchfab.com/3d-models/32145d6303e5487e9d92097b9845ef02) | "CC Attribution" | glb 19.5 MB | 108k faces (simplify 4×), Substance PBR, weathered green; hero wreck/cover | 5 | `sf_glb 32145d6303e5487e9d92097b9845ef02 btr80.glb` |
| ★ | **M725 Military Ambulance** — kryik1023 · [fbeafdb3…](https://sketchfab.com/3d-models/fbeafdb305114e4eb331d1b69d5fe094) | "CC Attribution" (retopo of a free scan) | glb 5.0 MB | **2.5k faces**, rusted scan look, cheap enough to instance | 5 | `sf_glb fbeafdb305114e4eb331d1b69d5fe094 m725.glb` |
| ★ | **Crashed Abandoned Car (game ready)** — rashad-brahimli · [66ef51a8…](https://sketchfab.com/3d-models/66ef51a84c9843dda53bf0b4b9020011) | "CC Attribution" | glb 4.5 MB | 8.3k faces, 4k Substance; smashed rusted SUV, separate doors/wheels | 5 | `sf_glb 66ef51a84c9843dda53bf0b4b9020011 crashed_suv.glb` |
| ★ | **Hind Attack Helicopter (Mi‑24D)** — AshleyAslett · [bb65bdfd…](https://sketchfab.com/3d-models/bb65bdfde2c54007a52dfbe1d91d930d) | "CC Attribution" | glb 5.9 MB | 35k faces, PBR camo; for the sky fly-by (animate rotor) | 4 | `sf_glb bb65bdfde2c54007a52dfbe1d91d930d hind.glb` |
|   | **Ural 4320** — davidbroutian · [f953c51a…](https://sketchfab.com/3d-models/f953c51a5dbc4a15949f4dcc0905c4e8) | "CC Attribution" | glb 1.9 MB | 8.5k faces, canvas-back military truck; a touch clean, so it needs the grime pass | 4 | `sf_glb f953c51a5dbc4a15949f4dcc0905c4e8 ural.glb` |
|   | **Military Truck** (M1009-style) — Raffey · [d3a85af5…](https://sketchfab.com/3d-models/d3a85af5faef4fddb217b3fce073614c) | "CC Attribution" | glb 11.1 MB | 67k faces, Substance PBR | 4 | `sf_glb d3a85af5faef4fddb217b3fce073614c mil_truck.glb` |
|   | **Abandoned Car – BMW E30** — roh3d · [32498418…](https://sketchfab.com/3d-models/32498418a32d43a78d0847ce4c55fcb0) | "CC Attribution" | glb 4.5 MB | 13k faces, rusted/green-mossy; mossiness needs desaturating for the dusty palette | 4 | `sf_glb 32498418a32d43a78d0847ce4c55fcb0 e30.glb` |
|   | **Burnt SUV (photoscan)** — azadbal · [3aeb4275…](https://sketchfab.com/3d-models/3aeb4275cbec4daba93af13a27993567) | "CC Attribution" | glb 13.6 MB | 259k-face raw scan, unlit (pbr none); best burnt detail but needs retopo/decimate and a de-lit pass | 3 | `sf_glb 3aeb4275cbec4daba93af13a27993567 burnt_suv.glb` |
|   | **Sikorsky UH‑60M** — MirzaArrafiERV_45 · [12b4e525…](https://sketchfab.com/3d-models/12b4e525676a49678ac3006b360c8750) | "CC Attribution" | glb 4.2 MB | 46k faces with interior/cockpit; non-PBR, but fine as a backlit silhouette fly-by | 3 | `sf_glb 12b4e525676a49678ac3006b360c8750 uh60.glb` |
|   | **Military Landvehicle Kit 1.2** — britdawgmasterfunk · [91f49543…](https://sketchfab.com/3d-models/91f495435f624d8b97a768f692aa6ce9) | Sketchfab "CC Attribution"; author: **"CC0… sketchfab does not allow you to untick the Attribution box"** | glb 140 MB | 3.5M faces kitbash parts (wheels, turrets, seats); untextured olive; source for custom wrecks only | 2 | `sf_glb 91f495435f624d8b97a768f692aa6ce9 landkit.glb` |

### 3b. Containers, barriers, fortifications

| ★ | Name / source | Licence | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Freight shipping container – Rusted** — sousinho · [2b787d1a…](https://sketchfab.com/3d-models/2b787d1a02174d0bbca9eac34eb3a486) | "CC Attribution" | glb 9.8 MB | 11k faces, PBR, doors/sides separate; heavy rust plus stencils | 5 | `sf_glb 2b787d1a02174d0bbca9eac34eb3a486 container_rust.glb` |
| ★ | **Hesco Barrier PBR** — polbrainstorm · [ab212174…](https://sketchfab.com/3d-models/ab21217481094e9a84f989e71fd56a59) | "CC Attribution" | glb 4.1 MB | 7k faces, photoreal mesh/geotextile; instant "military perimeter" read | 5 | `sf_glb ab21217481094e9a84f989e71fd56a59 hesco.glb` |
| ★ | **Sandbags** — Evanz · [8cda4370…](https://sketchfab.com/3d-models/8cda4370170746d393aa311a7c080c50) | "CC Attribution" | glb 4.3 MB | 5.8k faces, modular piles, PBR | 5 | `sf_glb 8cda4370170746d393aa311a7c080c50 sandbags.glb` |
| ★ | **Jersey Barrier** — emran.bayati · [b52246c9…](https://sketchfab.com/3d-models/b52246c9611a42a99a03b425535a0237) | "CC Attribution" | glb 3.1 MB | **1.7k tris, 4k texture**, chipped plus graffiti; complements Poly Haven `concrete_road_barrier` | 5 | `sf_glb b52246c9611a42a99a03b425535a0237 jersey.glb` |
|   | **Sandbags – Defense line** — Evanz · [e1a4c79a…](https://sketchfab.com/3d-models/e1a4c79a1c5e49bc830746be10dbe1c6) | **"CC Attribution-ShareAlike"**. Derivatives must stay BY-SA (OK for an open repo; flag it in credits) | glb 12.5 MB | 13 props incl. watchtower and barbed wire, 1k PBR, 165k faces total | 4 | `sf_glb e1a4c79a1c5e49bc830746be10dbe1c6 sandbag_line.glb` |
|   | **Container Pack** — drcrazzie · [0d416a9b…](https://sketchfab.com/3d-models/0d416a9bcfc14978aa50e80281dfe9a5) | "CC Attribution" | glb 66.8 MB | 8× 40 ft + 5× 20 ft with inner shells; 448k faces, so strip the interiors; colour variety for stacks | 4 | `sf_glb 0d416a9bcfc14978aa50e80281dfe9a5 containers.glb` |
|   | **Classic Shipping Container** — Sebastian.Hamish.Webster · [772f4be3…](https://sketchfab.com/3d-models/772f4be391a245f699c54e6cf157c58d) | "CC Attribution" | glb 4.3 MB | 17k faces, open doors, a bit clean | 4 | `sf_glb 772f4be391a245f699c54e6cf157c58d container_classic.glb` |
|   | **Military Outpost Kit 1.0** — britdawgmasterfunk · [010dc4f0…](https://sketchfab.com/3d-models/010dc4f0a73a48e7a53598c6f24fe9cf) | Sketchfab "CC Attribution"; author: **"CC0"** (also on Blendswap) | glb 8.6 MB | 230k faces: barriers, lights, generators, camo net; untextured/flat colours, so use for blockout and kitbash | 2 | `sf_glb 010dc4f0a73a48e7a53598c6f24fe9cf outpost_kit.glb` |

### 3c. Industrial props & modular structure (Poly Haven — CC0, same scan pipeline as current props)
Poly Haven licence: "All assets on Poly Haven are CC0". These are **not yet used** in the game.

| ★ | Asset id | Size (1k glTF) | Maps | Notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | [`modular_factory_facade`](https://polyhaven.com/a/modular_factory_facade) | 17.6 MB | brick/doors/garage ARM, diff, nor | Modular brick factory walls, windows, garage doors; ideal depot shell. 175k tris for the whole kit | 5 | `ph_gltf modular_factory_facade dl/` |
| ★ | [`wooden_military_crate`](https://polyhaven.com/a/wooden_military_crate) | 3.0 MB | arm, diff, nor_gl | 23k tris, stencilled ammo crate with an opening lid | 5 | `ph_gltf wooden_military_crate dl/` |
| ★ | [`modular_chainlink_fence`](https://polyhaven.com/a/modular_chainlink_fence) | 7.3 MB | posts + wire | Real geometry fence kit | 5 | `ph_gltf modular_chainlink_fence dl/` |
| ★ | [`old_military_compressor`](https://polyhaven.com/a/old_military_compressor) | 4.4 MB | arm, diff, nor | 79k tris (simplify), hero clutter | 5 | `ph_gltf old_military_compressor dl/` |
|   | [`rollershutter_door`](https://polyhaven.com/a/rollershutter_door) (+ windows 01–03) | 2.3 MB | incl. graffiti variant | 1.1k tris each | 5 | `ph_gltf rollershutter_door dl/` |
|   | [`modular_fire_escape`](https://polyhaven.com/a/modular_fire_escape) | 4.8 MB | 2 sets | Stairs/landings for verticality | 5 | `ph_gltf modular_fire_escape dl/` |
|   | [`modular_electricity_poles`](https://polyhaven.com/a/modular_electricity_poles) / [`modular_electric_cables`](https://polyhaven.com/a/modular_electric_cables) | 12.4 / 6.0 MB | | Skyline poles plus wall conduit | 5 | `ph_gltf modular_electricity_poles dl/` |
|   | [`overhead_crane`](https://polyhaven.com/a/overhead_crane) | 7.3 MB | + trim | Warehouse gantry crane | 5 | `ph_gltf overhead_crane dl/` |
|   | [`small_lpg_tank`](https://polyhaven.com/a/small_lpg_tank), [`portable_welding_cart`](https://polyhaven.com/a/portable_welding_cart), [`portable_searchlight`](https://polyhaven.com/a/portable_searchlight), [`worn_metal_rack`](https://polyhaven.com/a/worn_metal_rack), [`fire_hydrant`](https://polyhaven.com/a/fire_hydrant), [`street_lamp_02`](https://polyhaven.com/a/street_lamp_02), [`modular_airduct_rectangular_01`](https://polyhaven.com/a/modular_airduct_rectangular_01), [`old_gas_mask`](https://polyhaven.com/a/old_gas_mask) | 1.9–5.5 MB each | arm, diff, nor | Clutter set. The searchlight and gas mask sell the military setting; the hydrant has an "aged" texture set | 5 | `ph_gltf <id> dl/` |

### 3d. Other industrial structures (Sketchfab)

| ★ | Name / source | Licence | Format · Size | Notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Rusted Tank storage** — ixMkc1 · [57be2eaf…](https://sketchfab.com/3d-models/57be2eaf4d6b4d2980bcee4ccb35f780) | "CC Attribution" | glb 3.6 MB | 5.8k faces, 2k PBR; cylindrical fuel silo with cage ladder | 5 | `sf_glb 57be2eaf4d6b4d2980bcee4ccb35f780 tank.glb` |
|   | **Chemical tank** — ixMkc1 · [63c001e7…](https://sketchfab.com/3d-models/63c001e74ff5402fbcf1338479c9c0c5) | "CC Attribution" | glb 2.8 MB | 8.7k faces, 2k PBR, hazard labels | 5 | `sf_glb 63c001e74ff5402fbcf1338479c9c0c5 chem_tank.glb` |
|   | **Construction Pallet – Photoscan** — GameDevNick · [ee1dc525…](https://sketchfab.com/3d-models/ee1dc525a33d499bbad75c4e110050cd) | "CC Attribution" | glb 12.1 MB | 91k faces, scan of a pallet with cinder blocks (decimate) | 5 | `sf_glb ee1dc525a33d499bbad75c4e110050cd pallet_scan.glb` |
|   | **Pile of Old Tires** — orphanrtg · [3ee27bba…](https://sketchfab.com/3d-models/3ee27bba4aa7400aac276fb07d47cb21) | "CC Attribution" | glb 5.0 MB | 50k-face scan, 4×8k (downsize) | 4 | `sf_glb 3ee27bba4aa7400aac276fb07d47cb21 tires.glb` |
|   | **Warehouse FBX Model Free** — Nicholas01 · [daa7fd3f…](https://sketchfab.com/3d-models/daa7fd3ff88945298d00045ca40a4c03) | "CC Attribution" | glb 4.2 MB | 11k faces, Quonset-style hangar with wet floor; reference for interior shell or background | 3 | `sf_glb daa7fd3ff88945298d00045ca40a4c03 warehouse.glb` |
|   | **Ruined buildings pack** — tobiasherbers2 · [690edb7d…](https://sketchfab.com/3d-models/690edb7d64b84df7bfeee3b54746d6eb) | "CC Attribution" | glb 6.5 MB | 86k faces; low-detail skyline ruins "for foggy scenes": distant war-zone silhouettes beyond the walls | 3 | `sf_glb 690edb7d64b84df7bfeee3b54746d6eb ruins.glb` |

### 3e. Foliage & ground clutter (dusty depot)

| ★ | Name / source | Licence | Size | Notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | Poly Haven [`weed_plant_02`](https://polyhaven.com/a/weed_plant_02), [`nettle_plant`](https://polyhaven.com/a/nettle_plant), [`shrub_03`](https://polyhaven.com/a/shrub_03), [`dry_branches_medium_01`](https://polyhaven.com/a/dry_branches_medium_01) | CC0 | 1.6–3.3 MB each | Scanned weeds for cracks in asphalt and fence lines; 17k–47k tris (simplify) | 5 | `ph_gltf weed_plant_02 dl/` |
| ★ | ambientCG **Foliage001–008** (grass/weed atlases) · [ambientcg.com/list?type=Atlas](https://ambientcg.com/list?type=Atlas) | CC0 ("All assets… under the Creative Commons CC0 1.0 Universal License") | 1K zip ≈ 1–5 MB | Alpha-card grass blades plus dry seed-heads (Foliage003). Use for billboard tufts with `alphaOK` | 5 | `curl -L -o f3.zip "https://ambientcg.com/get?file=Foliage003_1K-PNG.zip"` |
|   | Poly Haven [`dead_tree_trunk`](https://polyhaven.com/a/dead_tree_trunk) | CC0 | 4.8 MB | Fallen dead trunk for the edges | 4 | `ph_gltf dead_tree_trunk dl/` |

---

## 4. VFX

| ★ | Name / source | Licence (verified) | Format · Size | Quality notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **Unity Labs "Free VFX image sequences & flipbooks"**: Explosion00/01/02/02HD (+ `‑nofire`, `‑light`), FireBall01–04, Flame02/03, SmallFlame01, WispySmoke01–03b, DiscSmoke01, Cloud01–04, CandleSmoke01 · [blog](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks) | **CC0**: blog text "…share with you under CC0 license. Feel free to use them in your projects!" | `*-flipbooks.zip` = 5×5/8×8 atlases as TGA (8-bit) **and EXR (HDR)**; 2.5–15 MB each (Explosion01 3.0 MB → 1024² 5×5) | **Houdini-rendered, photoreal**. Viewed Explosion01: fireball into rolling black smoke over 25 frames. Exactly the "burning wrecks, smoke columns, artillery flashes" brief. The EXR gives real HDR fire for bloom > 1 | 5 | `B=https://unity3d.com/files/labs/downloads/vfx/assets01; curl -LO $B/Explosion01/Explosion01-flipbooks.zip` (swap the name: `Explosion02HD/Explosion02HD`, `Flame03/Flame03`, `WispySmoke02/WispySmoke02`, `FireBall02/FireBall02`, `DiscSmoke01/DiscSmoke01`, `Cloud02/Cloud02`) |
| ★ | **TextureCan "Imperfection and Decal of Bullet Holes"** (imperfection_0003) + **"Punch Through Holes"** (0004) · [217](https://www.texturecan.com/details/217/), [218](https://www.texturecan.com/details/218/) | CC0: page meta `license="cc0"`; terms: "all the PBR textures… are under the Creative Commons CC0 1.0 Universal License" | 2k zip 11.4 MB; colour/normal/rough/height/**mask** | PBR bullet-hole decals (outward + inward), proper normals. Beats sprite decals | 5 | `curl -LO https://www.texturecan.com/downloads/imperfection_0003/imperfection_0003_2k_zJs2t9.zip`; `curl -LO https://www.texturecan.com/downloads/imperfection_0004/imperfection_0004_2k_kRtT4F.zip` |
| ★ | **ambientCG Leaking001–019C** (43 rain-streak decals) · [ambientcg.com/list?q=leaking](https://ambientcg.com/list?q=Leaking) | CC0 | 1K–2K zips | Game uses Leaking003 only. 012A–019C add variation (thin drips, broad stains) for `leakDecal` | 5 | `curl -L -o l16a.zip "https://ambientcg.com/get?file=Leaking016A_2K-JPG.zip"` |
| ★ | **ambientCG AsphaltDamageSet001/002**, **TireTracks001**, **GraffitiSet001**, **Tape001** (hazard stripes) | CC0 | AsphaltDamageSet001: 1K 5.1 MB / 2K 14.3 MB | Pothole/crack atlases with alpha, tyre-track decal, hazard tape; ground storytelling | 5 | `curl -L -o ad1.zip "https://ambientcg.com/get?file=AsphaltDamageSet001_2K-JPG.zip"` |
| ★ | **TextureCan "Rain Ripples Texture on Puddle"** (others_0028) + **"Decal: Asphalt Puddle Map"** (decals_0006) + **"Rain Droplet Texture"** (others_0004) · [531](https://www.texturecan.com/details/531/), [427](https://www.texturecan.com/details/427/), [155](https://www.texturecan.com/details/155/) | CC0 (as above) | 1k/2k zips | Ripple **normal** maps, puddle masks and droplet normals. These feed `uRain` ripples and wet-glass droplets | 5 | `curl -LO https://www.texturecan.com/downloads/others_0028/others_0028_2k_tghjEo.zip`; `curl -LO https://www.texturecan.com/downloads/decals_0006/decals_0006_2k_3VUpnY.zip`; `curl -LO https://www.texturecan.com/downloads/others_0004/others_0004_2k_k9P8Dc.zip` |
|   | **TextureCan "Wall Bottom Dirt Decal"** (decals_0001), **"Leaky Dirt Decal"** (decals_0008), **"Broken Glass with Cracks"** (imperfection_0001) · [333](https://www.texturecan.com/details/333/), [516](https://www.texturecan.com/details/516/), [19](https://www.texturecan.com/details/19/) | CC0 | 1k/2k zips | Contact-grime band, dirt splats, cracked-glass decal for shot windows | 5 | `curl -LO https://www.texturecan.com/downloads/decals_0001/decals_0001_2k_kMgv7g.zip` |
|   | **Seamless animated raindrop ripples** — OpenGameArt · [link](https://opengameart.org/content/seamless-animated-raindrop-ripples-texture) | CC0 (`publicdomain/zero/1.0`) | 30 × 512² PNG height frames (.7z) | Tileable animated **height** flipbook; convert to normals; author says "extremely basic" | 3 | `curl -LO https://opengameart.org/sites/default/files/ripples.7z` |
|   | **Kenney Particle Pack** (80+ masks: muzzle flashes, flares, scorch, sparks, smoke, fire) · [kenney.nl](https://kenney.nl/assets/particle-pack) | CC0 ("CC0 1.0 … free to use in personal, educational and commercial projects") | zip 15.0 MB | Grayscale soft masks, semi-stylised. Good **muzzle-flash star/cone cards** and spark streaks once tinted and HDR-boosted. Also **Smoke Particles** (6.0 MB) | 3 | `curl -LO https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip` |
|   | **Bullet Decal** — musdasch · [OGA](https://opengameart.org/content/bullet-decal) | CC0 | 512² PNG | Single hand-made bullet hole with crack ring; OK for concrete; prefer TextureCan | 3 | `curl -LO https://opengameart.org/sites/default/files/bullet_hole_0.png` |
|   | **Kenney Splat Pack** · [itch](https://kenney-assets.itch.io/splat-pack) | CC0 | 343 kB | 30+ splat shapes: **mask source** for blood/mud decals (tint dark red, add normals); no realistic CC0 blood decal pack exists | 2 | via itch page |

**Gaps (no acceptable source found):** photoreal muzzle-flash flipbooks and photoreal blood decals with CC0/CC‑BY
terms, and CC0 lens-dirt photos. The free Gumroad lens-dirt packs state no licence, so skip them. Recommendation: render
muzzle flashes and lens dirt procedurally (Blender/EmberGen-style render by us, which we own) and build blood decals
from Kenney splat masks plus a TextureCan normal.

---

## 5. Audio

| ★ | Name / source | Licence (verified) | Format · Size | Notes | Fit | Download |
|---|---|---|---|---|---|---|
| ★ | **The Free Firearm Sound Library** — buddingmonkey · [github](https://github.com/buddingmonkey/FreeFirearmsSFXLibrary) | `LICENSE`: "Creative Commons Legal Code — CC0 1.0 Universal" | WAV, multi-mic; full repo ≈ 194 MB (7z on OGA) | Already used for some guns. **Unused folders** cover the new weapons: `AR-15` (33), `AK-47` (51), `Mossberg` (31) and `Nova` (22) pump shotguns, `Mosin Nagant` (27), `1911` (43), `PPSh` (36), `Carl Gustav M45` SMG (37). Close and distant mics, plus mechanical foley | 5 | `git clone --depth 1 --filter=blob:none --sparse https://github.com/buddingmonkey/FreeFirearmsSFXLibrary && cd FreeFirearmsSFXLibrary && git sparse-checkout set "Master Tracks/AR-15" "Master Tracks/Mossberg"` |
| ★ | **War Ambience Loop** — qubodup · [freesound 239139](https://freesound.org/people/qubodup/sounds/239139/) | CC0 per Freesound listing ("extracted from a video… by a US Government agency, thus public domain") | 24 s loop | Distant small-arms battle bed for "beyond the walls" | 5 | download on page (login) |
| ★ | **distant explosions** — Kostrava · [freesound 320788](https://freesound.org/s/320788/) | CC0 per listing | ~60 s | Rolling distant artillery; pair with flashes on the clouds | 5 | download on page |
| ★ | **Rain (loopable)** — Ylmir · [OGA](https://opengameart.org/content/rain-loopable) | CC0 (`publicdomain/zero/1.0`) | 4 loops 25–45 s, OGG/MP3 | Clean rain beds | 4 | `curl -LO "https://opengameart.org/sites/default/files/Rain%20OGG.zip"` |
|   | **Rain on metal roof with distant thunder** — DBlover · [freesound 404061](https://freesound.org/s/404061/) | CC0 per listing | ~5 min MP3 | Interior warehouse roof ambience, plus his **Howling Wind Ambience** ([405601](https://freesound.org/people/DBlover/sounds/405601/), CC0) | 5 | download on page |
|   | **Helicopter Loop** / **Helicopter Rotor Loop** — qubodup · [187678](https://freesound.org/people/qubodup/sounds/187678/), [187681](https://freesound.org/people/qubodup/sounds/187681/) | CC0 per listing (US-Gov-sourced) | FLAC loops | Fly-by layer (doppler in engine) | 4 | download on page |
|   | **air raid sirens** — nsstudios · [351512](https://freesound.org/people/nsstudios/sounds/351512/); **Air raid siren (Prague)** — nooly · [382611](https://freesound.org/people/nooly/sounds/382611/) | CC0 per listing | ~1 min field recordings | Distant war-zone colour, used sparingly | 4 | download on page |
|   | **rain and thunders** ("Dark Rainy Night") — kindland · [OGA](https://opengameart.org/content/rain-and-thunders) | CC0 | OGG | Storm bed with thunder | 4 | `curl -LO "https://opengameart.org/sites/default/files/Dark_Rainy_Night%28ambience%29.ogg"` |
|   | **Gun reload sounds** — SpringySpringo · [OGA](https://opengameart.org/content/gun-reload-sounds) | CC0 | WAV | Airsoft-recorded reloads; filler only | 3 | `curl -LO https://opengameart.org/sites/default/files/assaultriflereload1_0.wav` |
|   | **Gunshot Sounds** — Tabasco · [OGA](https://opengameart.org/content/gunshot-sounds) | CC0 | zip | CZ‑52, Mosin, SKS, shotgun at a range; clipped levels, so use as distant layers | 3 | `curl -LO https://opengameart.org/sites/default/files/sounds.zip` |
|   | **Kenney UI Audio / Interface Sounds** · [ui-audio](https://kenney.nl/assets/ui-audio), [interface-sounds](https://kenney.nl/assets/interface-sounds) | CC0 | small zips | Menu clicks, confirm/deny, kill-feed ticks (Impact Sounds already used) | 4 | `curl -LO https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip` |
| ⚠ | **Sonniss GameAudioGDC bundles** · sonniss.com/gameaudiogdc | Royalty-free, but licence forbids redistributing sounds **as standalone files**. A public repo exposes raw files, so it is **not cleared** for an open-source repo | 20–30 GB/yr | Best quality available (explosions, foley, ambience). Only usable if the repo keeps audio packed/encoded in-game and the team accepts the reading; ask before adopting | — | — |

Freesound pages were blocked from this sandbox. Licences above come from the listing text. Re-check the licence badge
on each page before committing, and log user/ID in credits (qubodup asks for an optional link-back).

---

## 6. HDRIs (stormy / golden-hour skies)
All Poly Haven, CC0. All have a sun near the horizon, real cloud structure and an unclipped sun (EVs 9–27). 2k `.hdr`
≈ 6 MB each. The current sky is `bambanani_sunset`; these give a more storm-laden option or alternate times.

| ★ | HDRI | EVs | Look | Fit | Download (2k) |
|---|---|---|---|---|---|
| ★ | [`the_sky_is_on_fire`](https://polyhaven.com/a/the_sky_is_on_fire) | 9 | Dramatic fiery sunset under a broken purple-grey storm deck, urban lot. The closest match to "low sun breaking through storm clouds" | 5 | `curl -LO https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/the_sky_is_on_fire_2k.hdr` |
| ★ | [`minedump_flats`](https://polyhaven.com/a/minedump_flats) | 23 | Golden-hour sun through heavy cumulus over dusty mine-dump flats; matches the dusty depot ground | 5 | `…/hdr/2k/minedump_flats_2k.hdr` |
| ★ | [`wasteland_clouds`](https://polyhaven.com/a/wasteland_clouds) (+ `_puresky`) | 16 | Low sun, dense moody cloud layer, scrubby wasteland | 5 | `…/hdr/2k/wasteland_clouds_2k.hdr` |
|   | [`abandoned_tank_farm_05`](https://polyhaven.com/a/abandoned_tank_farm_05) | 27 | Industrial ruin site, high dynamic range; brighter mid-day-ish | 4 | `…/hdr/2k/abandoned_tank_farm_05_2k.hdr` |
|   | [`freight_station`](https://polyhaven.com/a/freight_station) | 23 | Gantry crane silhouette, warm horizon; on-theme backdrop | 4 | `…/hdr/2k/freight_station_2k.hdr` |
|   | [`kloppenheim_06`](https://polyhaven.com/a/kloppenheim_06) (+ `_puresky`) | 12 | Sunset with scattered storm cumulus; the pure-sky version is great for GroundedSkybox swaps | 4 | `…/hdr/2k/kloppenheim_06_2k.hdr` |
|   | [`industrial_sunset_02`](https://polyhaven.com/a/industrial_sunset_02) (+ `_puresky`) | 12 | Hazy industrial horizon at sunset (lighter clouds) | 3 | `…/hdr/2k/industrial_sunset_02_2k.hdr` |
|   | ambientCG **EveningSkyHDRI028A/029A/030A** · [ambientcg](https://ambientcg.com/list?type=HDRI&q=evening) | CC0 | Heavy overcast evening, rain-ready | 3 | `curl -L -o s.zip "https://ambientcg.com/get?file=EveningSkyHDRI030A_2K.zip"` |

---

## 7. GitHub game repos checked (art inside open-source games)

| Repo | What's there | Licence status | Verdict |
|---|---|---|---|
| [microsoft/Microsoft-Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | 115 rigged humans incl. 8 Military, 417 anims | MIT covers the assets (README states it) | ★ use (see §2). **Don't** `git ls-tree -l`: it lazily fetches every blob (290 MB) |
| [buddingmonkey/FreeFirearmsSFXLibrary](https://github.com/buddingmonkey/FreeFirearmsSFXLibrary) | Firearm recordings | CC0 `LICENSE` | ★ use (see §5) |
| [AetherRadar/operation-steel-tide](https://github.com/AetherRadar/operation-steel-tide) | Weapons/arms already adopted; also Trey Ramm Modular Industrial (CC0), Kenney/Quaternius city kits (CC0), Majadroid construction site (CC0) | Per-asset `LICENSE.md` with provenance (excellent) | Remaining kits are **low-poly/stylised (fit 1–2)**. `assets/models/hy3d_operators` are Hunyuan3D **AI-generated**, so excluded |
| [Mugen87/dive](https://github.com/Mugen87/dive) | Shotgun (CC-BY, used), soldier, rifle | `app/models/README.md`: rifle is **CC BY‑NC**, soldier is **Mixamo "License: None"** | Only the shotgun is clean (already used) |
| [mohsenheydari/three-fps](https://github.com/mohsenheydari/three-fps) | AK‑47, decals, mutant anims | MIT code; AK credited CC-BY on Sketchfab **but textures are `T_INS_Body_a`/`T_INS_Skin_a` (Insurgency rip)**; anims are Mixamo | **Excluded** |
| OpenGameArt Quaternius/Kenney/"CC0 Flat Guns West/East" | Low-poly guns, city kits | CC0 | Clean but **fit 1–2** (flat-shaded); don't mix with photoreal |

---

## 8. Integration notes
- **Budget**: most Sketchfab "game ready" guns are 15–80k faces with 4k maps. Run `gltf-transform optimize` with
  `--texture-size 1024` (2048 for the first-person gun only) and `--simplify` for world models (≤ 8k tris per the
  pipeline). ccransh rigs keep their skinning/clips. Verify clip names after optimisation.
- **One arm mesh**: standardise on DJMaesen's arms (CC‑BY) for all weapons. For VSK/Benelli, transplant the clips onto the
  DJMaesen arm skeleton (same rig family) instead of shipping two arm styles.
- **Spec-gloss models** (pistol rig, UH‑60, Rocketbox): convert with `gltf-transform metalrough` before the unify pass.
- **Unlit scans** (Burnt SUV, M725 source scan): de-light the albedo, or the unify clamp will flatten baked shadows.
- **Credits**: append each CC‑BY item to `README.md` › Credits as "Title by Author (link), CC BY 4.0, modified
  (decimated/retextured)". BY‑SA items (Evanz Defense line, DJMaesen battle rifle) keep their derivative under BY‑SA.

---

## 9. Rejected — do not use

| Asset | Reason |
|---|---|
| German KSK operator, RPK‑16, GAZ Tigr, HMMWV, Azov fighter — **42manako** (Sketchfab) | Description: "Model ripped from Call to Arms". Commercial game rip, so CC-BY label is invalid |
| Animated AKs‑74u — dan741vlasov | Hands/AKS from **GameBanana** (CS:S mod assets by tigg/Millenia); unclear rights |
| Animated FPS M4A4 — teenjust500 | CS:GO naming; likely fan recreation of game IP; not needed given the alternatives |
| M249 "Counter Strike 2", "ROBLOX M249", "Halo … Remake", "M4 (Cod Warzone Style)" | Game-IP recreations/rips |
| three-fps AK‑47 textures (`T_INS_*`) | Insurgency textures inside a CC‑BY upload |
| Mixamo characters/animations (three.js `Soldier.glb`, dive soldier, three-fps mutant) | Not redistributable |
| dive "Sci-Fi Assault Rifle" (Ptis) | CC BY‑NC |
| Bandai Namco motion dataset, BBC Sound Effects, Pixabay/Mixkit audio | NC or no standalone redistribution |
| Sketchfab "Free Standard"/"Standard", Fab/Unity Asset Store/TurboSquid | Store licences. Later exception: the user-supplied Free FPS Template (Fab) is used for its rifle animation *motion* only, under its Fab licence; no template mesh ships |
| operation-steel-tide `hy3d_operators` | AI-generated (Hunyuan3D), unclear rights |
| Gumroad lens-dirt packs, summerengine "realistic FPS VFX atlas" | No licence stated / AI concept pages |
| Renderpeople scanned civilians (CC‑BY samples) | Licence OK, but civilians in casual clothes; off-theme (keep for a possible civilian-panic set piece) |
