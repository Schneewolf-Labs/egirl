def summarize(store) -> str:
    lines = []
    for item in store.all_items():
        lines.append(f"{item.sku}: {item.name} x{item.qty}")
    return "\n".join(lines)
