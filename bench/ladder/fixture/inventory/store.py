from dataclasses import dataclass


@dataclass
class Item:
    sku: str
    name: str
    qty: int
    unit_price: float


class Store:
    """In-memory inventory keyed by SKU."""

    def __init__(self):
        self._items = {}

    def add(self, item: Item) -> None:
        if item.sku in self._items:
            self._items[item.sku].qty += item.qty
        else:
            self._items[item.sku] = item

    def remove(self, sku: str, qty: int) -> None:
        item = self._items.get(sku)
        if item is None:
            raise KeyError(sku)
        item.qty -= qty

    def get(self, sku: str):
        return self._items.get(sku)

    def all_items(self):
        return list(self._items.values())

    def total_value(self) -> float:
        return sum(i.qty * i.unit_price for i in self._items.values())
