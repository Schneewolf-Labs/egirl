import unittest
from inventory import Store, Item


class TestStore(unittest.TestCase):
    def test_add_and_get(self):
        s = Store()
        s.add(Item("A1", "Widget", 5, 2.0))
        self.assertEqual(s.get("A1").qty, 5)

    def test_add_merges(self):
        s = Store()
        s.add(Item("A1", "Widget", 5, 2.0))
        s.add(Item("A1", "Widget", 3, 2.0))
        self.assertEqual(s.get("A1").qty, 8)

    def test_total_value(self):
        s = Store()
        s.add(Item("A1", "Widget", 2, 3.0))
        s.add(Item("B2", "Gadget", 1, 10.0))
        self.assertEqual(s.total_value(), 16.0)


if __name__ == "__main__":
    unittest.main()
