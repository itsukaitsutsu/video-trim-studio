"""Validated, silent full-frame overlays on the output timeline."""
from .timeline import TimelineError, _num, _item_id, MIN_LEN


def normalize(items, assets: dict, length: float) -> list[dict]:
    if not isinstance(items, list):
        raise TimelineError('B-roll must be a list.')
    if len(items) > 100:
        raise TimelineError('Use at most 100 B-roll clips per timeline.')
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise TimelineError('Each B-roll clip must be an object.')
        asset_id = str(item.get('asset_id', ''))
        if asset_id not in assets:
            raise TimelineError('B-roll media is missing. Upload the clip again.')
        start = round(_num(item.get('start'), 'B-roll start'), 3)
        end = round(_num(item.get('end'), 'B-roll end'), 3)
        src = round(_num(item.get('in', 0), 'B-roll source in'), 3)
        if start < 0 or end - start < MIN_LEN - .001 or src < 0:
            raise TimelineError('B-roll needs a nonnegative start/in and at least 0.05 seconds.')
        if src + end - start > assets[asset_id]['duration'] + .02:
            raise TimelineError('B-roll runs past the end of its source.')
        if end > length + .001:
            raise TimelineError('B-roll runs past the end of the main timeline. Trim or remove it first.')
        fit = item.get('fit', 'cover')
        if fit not in ('cover', 'contain'):
            raise TimelineError('B-roll fit must be cover or contain.')
        result.append(dict(id=_item_id(item, 'b'), asset_id=asset_id,
                           start=start, end=end, **{'in': src}, fit=fit))
    result.sort(key=lambda c: (c['start'], c['end']))
    for a, b in zip(result, result[1:]):
        if b['start'] < a['end'] - .001:
            raise TimelineError('B-roll clips overlap. Move or trim them on B1.')
    return result


def overlay_filter(items: list[dict], size: tuple[int, int], fps: float,
                   input_label='[basev]', output_label='[outv]') -> str:
    """B-roll inputs follow input 0. Captions must run AFTER this graph."""
    w, h = size
    parts = []
    previous = input_label
    for i, c in enumerate(items, 1):
        duration = c['end'] - c['start']
        fit = (f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}'
               if c.get('fit', 'cover') == 'cover' else
               f'scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black')
        parts.append(f'[{i}:v]trim=start={c["in"]:.6f}:duration={duration:.6f},'
                     f'setpts=PTS-STARTPTS,fps={fps:.6f},{fit},setsar=1,'
                     f'setpts=PTS+{c["start"]:.6f}/TB[br{i}]')
        target = output_label if i == len(items) else f'[mix{i}]'
        parts.append(f'{previous}[br{i}]overlay=eof_action=pass:repeatlast=0:'
                     f"enable='gte(t,{c['start']:.6f})*lt(t,{c['end']:.6f})'{target}")
        previous = target
    return ';'.join(parts)
