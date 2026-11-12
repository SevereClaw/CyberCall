# Готовит данные для сравнения распознавателей: модели Whisper и фразы из FLEURS (реальная речь с расшифровкой).
import csv, io, os, sys, tarfile, json
from huggingface_hub import hf_hub_download, snapshot_download

out = sys.argv[1]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 12

for name in ("whisper-base", "whisper-small"):
    snapshot_download(f"onnx-community/{name}", local_dir=f"{out}/models/onnx-community/{name}",
                      allow_patterns=["*.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"])

clips = []
for lang in ("ru_ru", "en_us"):
    tsv = hf_hub_download("google/fleurs", f"data/{lang}/test.tsv", repo_type="dataset")
    tgz = hf_hub_download("google/fleurs", f"data/{lang}/audio/test.tar.gz", repo_type="dataset")
    rows = [r for r in csv.reader(open(tsv, encoding="utf-8"), delimiter="\t")]
    want = {}
    for r in rows:
        if r[1] not in want and len(want) < N:
            want[r[1]] = r[3]
    os.makedirs(f"{out}/audio", exist_ok=True)
    with tarfile.open(tgz) as t:
        for m in t:
            base = os.path.basename(m.name)
            if base in want:
                open(f"{out}/audio/{lang}-{base}", "wb").write(t.extractfile(m).read())
                clips.append({"lang": lang[:2], "file": f"audio/{lang}-{base}", "ref": want[base]})
json.dump(clips, open(f"{out}/clips.json", "w"), ensure_ascii=False, indent=1)
print("clips:", len(clips))
